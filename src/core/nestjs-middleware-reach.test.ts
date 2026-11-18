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

const GUARD = `import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { pool } from "./db";

@Injectable()
export class HeaderGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const rows = await pool.query("SELECT * FROM sessions WHERE token = $1", [req.headers["x-league-key"]]);
    return rows.rowCount > 0;
  }
}
`;

/** Same class name as the real guard; must never join a route. */
const DECOY = `import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { pool } from "../src/db";

@Injectable()
export class HeaderGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await pool.query("SELECT * FROM decoy_tokens");
    return true;
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

const MODULE_BOOTSTRAP = `import { Module } from "@nestjs/common";
import { ClubsController } from "./clubs.controller";

@Module({ controllers: [ClubsController] })
export class AppModule {}
`;

const MODULE_APP_GUARD = `import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClubsController } from "./clubs.controller";
import { HeaderGuard } from "./header.guard";

@Module({
  controllers: [ClubsController],
  providers: [{ provide: APP_GUARD, useClass: HeaderGuard }],
})
export class AppModule {}
`;

const MAIN = `import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { HeaderGuard } from "./header.guard";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new HeaderGuard());
  await app.listen(3000);
}
void bootstrap();
`;

/** A namesake method that must not become a Nest global guard. */
const NOT_A_GUARD = `export class DecoyService {
  useGlobalGuards() {
    return "not a nest app";
  }
}
const decoy = new DecoyService();
decoy.useGlobalGuards();
`;

describe("NestJS useGlobalGuards middleware reach", () => {
  it("joins what the global guard reads to every route, never a namesake or a decoy method", async () => {
    const { analysis } = await runCarets({
      "package.json": PKG,
      "src/db.ts": DB,
      "src/header.guard.ts": GUARD,
      "decoy/header.guard.ts": DECOY,
      "src/clubs.controller.ts": CONTROLLER,
      "src/app.module.ts": MODULE_BOOTSTRAP,
      "src/main.ts": MAIN,
      "src/not-a-guard.ts": NOT_A_GUARD,
    });
    const route = (analysis.routeMap ?? []).find((r) => r.path === "/clubs/:id");
    expect(route?.middleware).toContain("useGlobalGuards(HeaderGuard)");
    expect(route?.auth?.policies).toContain("HeaderGuard");
    expect(route?.inheritedMiddleware).toEqual([
      { file: "src/main.ts", calls: ["HeaderGuard.canActivate"] },
    ]);
    const flows = (analysis.dataFlows ?? [])
      .map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`)
      .sort();
    expect(flows).toEqual([
      "GET /clubs/:id clubs",
      "GET /clubs/:id sessions (middleware)",
    ]);
    expect(flows.some((f) => f.includes("decoy_tokens"))).toBe(false);
  });

  it("joins APP_GUARD providers to every route, never a namesake guard elsewhere", async () => {
    const { analysis } = await runCarets({
      "package.json": PKG,
      "src/db.ts": DB,
      "src/header.guard.ts": GUARD,
      "decoy/header.guard.ts": DECOY,
      "src/clubs.controller.ts": CONTROLLER,
      "src/app.module.ts": MODULE_APP_GUARD,
    });
    const route = (analysis.routeMap ?? []).find((r) => r.path === "/clubs/:id");
    expect(route?.middleware).toContain("APP_GUARD(HeaderGuard)");
    expect(route?.auth?.policies).toContain("HeaderGuard");
    expect(route?.inheritedMiddleware).toEqual([
      { file: "src/app.module.ts", calls: ["HeaderGuard.canActivate"] },
    ]);
    const flows = (analysis.dataFlows ?? [])
      .map((f) => `${f.entryLabel} ${f.resource}${f.viaMiddleware ? " (middleware)" : ""}`)
      .sort();
    expect(flows).toEqual([
      "GET /clubs/:id clubs",
      "GET /clubs/:id sessions (middleware)",
    ]);
    expect(flows.some((f) => f.includes("decoy_tokens"))).toBe(false);
  });
});
