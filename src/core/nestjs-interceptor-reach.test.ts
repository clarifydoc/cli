import { describe, it, expect } from "vitest";
import { runCarets } from "./caret-testkit.js";

const PKG = JSON.stringify({
  name: "league-server",
  dependencies: {
    "@nestjs/common": "10.0.0",
    "@nestjs/core": "10.0.0",
    pg: "8.0.0",
    "reflect-metadata": "0.1.0",
    rxjs: "7.0.0",
  },
});

const DB = `import { Pool } from "pg";
export const pool = new Pool();
`;

const INTERCEPTOR = `import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { pool } from "./db";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    void pool.query("INSERT INTO audit_log (path) VALUES ($1)", [req.url]);
    return next.handle();
  }
}
`;

/** Same class name as the real interceptor; must never join a route. */
const DECOY = `import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { pool } from "../src/db";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    void pool.query("INSERT INTO decoy_audit");
    return next.handle();
  }
}
`;

const CONTROLLER = `import { Controller, Get, Param } from "@nestjs/common";
import { pool } from "./db";

@Controller("clubs")
export class ClubsController {
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const rows = await pool.query("SELECT * FROM clubs WHERE id = $1", [id]);
    return rows.rows[0];
  }
}
`;

const MODULE = `import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuditInterceptor } from "./audit.interceptor";
import { ClubsController } from "./clubs.controller";

@Module({
  controllers: [ClubsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
`;

const MAIN = `import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AuditInterceptor } from "./audit.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalInterceptors(new AuditInterceptor());
  await app.listen(3000);
}
void bootstrap();
`;

const NOT_NEST = `export class DecoyService {
  useGlobalInterceptors() {
    return "not a nest app";
  }
}
new DecoyService().useGlobalInterceptors();
`;

describe("NestJS APP_INTERCEPTOR middleware reach", () => {
  it("joins what the interceptor writes through inheritedMiddleware, never a namesake", async () => {
    const { analysis } = await runCarets({
      "package.json": PKG,
      "src/db.ts": DB,
      "src/audit.interceptor.ts": INTERCEPTOR,
      "decoy/audit.interceptor.ts": DECOY,
      "src/clubs.controller.ts": CONTROLLER,
      "src/app.module.ts": MODULE,
    });
    const route = (analysis.routeMap ?? []).find((r) => r.path === "/clubs/:id");
    expect(route?.middleware).toContain("APP_INTERCEPTOR(AuditInterceptor)");
    expect(route?.inheritedMiddleware).toEqual([
      { file: "src/app.module.ts", calls: ["AuditInterceptor.intercept"] },
    ]);
    const flows = (analysis.dataFlows ?? [])
      .map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`)
      .sort();
    expect(flows).toEqual([
      "GET /clubs/:id audit_log (middleware)",
      "GET /clubs/:id clubs",
    ]);
    expect(flows.some((f) => f.includes("decoy_audit"))).toBe(false);
  });
});

describe("NestJS useGlobalInterceptors middleware reach", () => {
  it("joins project interceptor reach to every route, not a decoy method or namesake", async () => {
    const { analysis } = await runCarets({
      "package.json": PKG,
      "src/db.ts": DB,
      "src/audit.interceptor.ts": INTERCEPTOR,
      "decoy/audit.interceptor.ts": DECOY,
      "src/clubs.controller.ts": CONTROLLER,
      "src/app.module.ts": `import { Module } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";

@Module({ controllers: [ClubsController] })
export class AppModule {}
`,
      "src/main.ts": MAIN,
      "src/not-nest.ts": NOT_NEST,
    });
    const route = (analysis.routeMap ?? []).find((r) => r.path === "/clubs/:id");
    expect(route?.middleware).toContain("useGlobalInterceptors(AuditInterceptor)");
    expect(route?.inheritedMiddleware).toEqual([
      { file: "src/main.ts", calls: ["AuditInterceptor.intercept"] },
    ]);
    const flows = (analysis.dataFlows ?? [])
      .map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`)
      .sort();
    expect(flows).toEqual([
      "GET /clubs/:id audit_log (middleware)",
      "GET /clubs/:id clubs",
    ]);
    expect(flows.some((f) => f.includes("decoy_audit"))).toBe(false);
  });

  it("records framework interceptor middleware text without inheritedMiddleware reach", async () => {
    const { analysis } = await runCarets({
      "package.json": PKG,
      "src/clubs.controller.ts": CONTROLLER,
      "src/app.module.ts": `import { Module } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";

@Module({ controllers: [ClubsController] })
export class AppModule {}
`,
      "src/main.ts": `import { NestFactory, Reflector } from "@nestjs/core";
import { ClassSerializerInterceptor } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  await app.listen(3000);
}
void bootstrap();
`,
    });
    const route = (analysis.routeMap ?? []).find((r) => r.path === "/clubs/:id");
    expect(route?.middleware).toContain("useGlobalInterceptors(ClassSerializerInterceptor)");
    expect(route?.inheritedMiddleware).toBeUndefined();
  });
});