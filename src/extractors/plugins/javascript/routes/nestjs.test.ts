import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import {
  collectNestAppGuards,
  collectNestAppInterceptors,
  collectNestGlobalGuards,
  collectNestGlobalInterceptors,
  extractNestjsRoutes,
  type NestGlobalGuardsFact,
  type NestGlobalInterceptorsFact,
} from "./nestjs.js";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "players.controller.ts");
  const routes: RouteInfo[] = [];
  extractNestjsRoutes(tree.rootNode, routes);
  return routes;
}

const CONTROLLER = `import { Controller, Get, Post, Body, Param, Query, Headers, Req, UseGuards, Version } from '@nestjs/common';

@Controller('players')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @Get(':id')
  @Roles('admin', 'editor')
  findOne(@Param('id') id: string, @Query('q') q?: string, @Headers('x-tenant') tenant: string, @Req() req: Request) {
    return this.players.find(id);
  }

  @Post()
  @Version('2')
  create(@Body() dto: CreatePlayerDto, plain: number) {
    return this.players.create(dto);
  }

  @Public()
  @Get()
  list(@Query() filter: ListPlayersQuery) {
    return this.players.list(filter);
  }

  @Post(':id/avatar')
  upload(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body('caption') caption: string) {}
}
`;

describe("NestJS routes — handler and prefix", () => {
  it("names the decorated method as handler, not the first method in the class", async () => {
    const routes = await routesOf(CONTROLLER);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /players/:id -> findOne",
      "POST /players -> create",
      "GET /players -> list",
      "POST /players/:id/avatar -> upload",
    ]);
  });

  it("merges the @Controller prefix on a non-exported class and an empty prefix", async () => {
    const routes = await routesOf(`@Controller() class Health { @Get('ping') ping() {} }
      @Controller({ path: 'v', version: '1' }) class V { @Get('/x/') x() {} }`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /ping -> ping",
      "GET /v/x -> x",
    ]);
    expect(routes[1]!.versions).toEqual(["1"]);
  });
});

describe("NestJS routes — auth", () => {
  it("inherits class-level @UseGuards and adds method-level @Roles", async () => {
    const routes = await routesOf(CONTROLLER);
    const findOne = routes.find((r) => r.handler === "findOne")!;
    expect(findOne.middleware).toEqual(["UseGuards(AuthGuard('jwt'), RolesGuard)", "Roles('admin', 'editor')"]);
    expect(findOne.auth).toEqual({
      policies: ["RolesGuard"],
      roles: ["admin", "editor"],
      schemes: ["jwt"],
      anonymous: false,
      inherited: false,
    });
    const create = routes.find((r) => r.handler === "create")!;
    expect(create.auth?.inherited).toBe(true);
    expect(create.auth?.schemes).toEqual(["jwt"]);
  });

  it("marks @Public() as anonymous while keeping the inherited guards visible", async () => {
    const routes = await routesOf(CONTROLLER);
    const list = routes.find((r) => r.handler === "list")!;
    expect(list.auth?.anonymous).toBe(true);
    expect(list.middleware).toEqual(["UseGuards(AuthGuard('jwt'), RolesGuard)", "Public()"]);
  });

  it("emits no auth when nothing is declared", async () => {
    const routes = await routesOf(`@Controller('open') export class C { @Get() x() {} }`);
    expect(routes[0]!.auth).toBeUndefined();
    expect(routes[0]!.middleware).toEqual([]);
  });

  it("names each UseGuards class as middlewareCalls → canActivate", async () => {
    const routes = await routesOf(CONTROLLER);
    const findOne = routes.find((r) => r.handler === "findOne")!;
    expect(findOne.middlewareCalls).toEqual(["AuthGuard.canActivate", "RolesGuard.canActivate"]);
    const create = routes.find((r) => r.handler === "create")!;
    expect(create.middlewareCalls).toEqual(["AuthGuard.canActivate", "RolesGuard.canActivate"]);
  });
});

describe("NestJS routes — versions", () => {
  it("takes @Version on the method over the class, in array form too", async () => {
    const routes = await routesOf(`@Controller('v') @Version('1') export class C {
      @Get('a') a() {}
      @Get('b') @Version(['2', '3']) b() {}
    }`);
    expect(routes.find((r) => r.handler === "a")!.versions).toEqual(["1"]);
    expect(routes.find((r) => r.handler === "b")!.versions).toEqual(["2", "3"]);
    const create = (await routesOf(CONTROLLER)).find((r) => r.handler === "create")!;
    expect(create.versions).toEqual(["2"]);
  });
});

describe("NestJS routes — params", () => {
  it("binds parameter decorators explicitly and infers the rest", async () => {
    const routes = await routesOf(CONTROLLER);
    expect(routes.find((r) => r.handler === "findOne")!.params).toEqual([
      { name: "id", type: "string", binding: "route" },
      { name: "q", type: "string", binding: "query" },
      { name: "x-tenant", type: "string", binding: "header" },
      { name: "req", type: "Request", binding: "services", inferred: true },
    ]);
    expect(routes.find((r) => r.handler === "create")!.params).toEqual([
      { name: "dto", type: "CreatePlayerDto", binding: "body" },
      { name: "plain", type: "number", binding: null },
    ]);
    expect(routes.find((r) => r.handler === "list")!.params).toEqual([
      { name: "filter", type: "ListPlayersQuery", binding: "query" },
    ]);
    expect(routes.find((r) => r.handler === "upload")!.params).toEqual([
      { name: "id", type: "string", binding: "route" },
      { name: "file", type: "Express.Multer.File", binding: "form" },
      { name: "caption", type: "string", binding: "body" },
    ]);
  });

  it("omits params on a parameterless action and infers a path token by name", async () => {
    const routes = await routesOf(`@Controller('t') export class C {
      @Get() none() {}
      @Get(':id') byToken(id: string) {}
    }`);
    expect(routes[0]!.params).toBeUndefined();
    expect(routes[1]!.params).toEqual([{ name: "id", type: "string", binding: "route", inferred: true }]);
  });
});

describe("a comment inside a decorator run", () => {
  it("still gives the route its handler (real-repo FP: a TODO before the method left handler null)", async () => {
    const routes = await routesOf(`@Controller('libraries') export class LibraryController {
  @Post(':id/validate')
  @Authenticated({ admin: true })
  // TODO: should be a GET
  validate(@Param('id') id: string) {}
}`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual(["POST /libraries/:id/validate validate"]);
  });
});

describe("NestJS useGlobalGuards facts", () => {
  async function factsOf(src: string): Promise<RouteFact[]> {
    const tree = await parseSource(src, "typescript" as any, "main.ts");
    const facts: RouteFact[] = [];
    collectNestGlobalGuards(tree.rootNode, src, facts);
    return facts;
  }

  it("records HeaderGuard from NestFactory bootstrap, and ignores a namesake method", async () => {
    const nest = await factsOf(`import { NestFactory } from "@nestjs/core";
import { HeaderGuard } from "./header.guard";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new HeaderGuard());
}
`);
    expect(nest).toHaveLength(1);
    expect(nest[0]!.data as NestGlobalGuardsFact).toEqual({
      guards: [{ text: "useGlobalGuards(HeaderGuard)", policies: ["HeaderGuard"] }],
      calls: ["HeaderGuard.canActivate"],
    });

    const decoy = await factsOf(`export class DecoyService {
  useGlobalGuards() { return "no"; }
}
new DecoyService().useGlobalGuards();
`);
    expect(decoy).toEqual([]);
  });

  it("names AuthGuard from new AuthGuard(…, app.get(…))", async () => {
    const facts = await factsOf(`import { NestFactory } from "@nestjs/core";
  const app = await NestFactory.create(AppModule);
  app.useGlobalGuards(new AuthGuard(reflector, app.get(AuthService)));
`);
    expect((facts[0]!.data as NestGlobalGuardsFact).calls).toEqual(["AuthGuard.canActivate"]);
  });
});

describe("NestJS APP_GUARD providers", () => {
  async function factsOf(src: string, file = "app.module.ts"): Promise<RouteFact[]> {
    const tree = await parseSource(src, "typescript" as any, file);
    const facts: RouteFact[] = [];
    collectNestAppGuards(tree.rootNode, src, facts);
    return facts;
  }

  it("records useClass, useExisting, and useValue registrations", async () => {
    const facts = await factsOf(`import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { MaintenanceAuthGuard } from "./maintenance.guard";

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useExisting: MaintenanceAuthGuard },
    { provide: APP_GUARD, useValue: new AuthGuard() },
  ],
})
export class AppModule {}
`);
    expect(facts.map((f) => (f.data as NestGlobalGuardsFact).guards[0]!.text)).toEqual([
      "APP_GUARD(AuthGuard)",
      "APP_GUARD(MaintenanceAuthGuard)",
      "APP_GUARD(AuthGuard)",
    ]);
    expect(facts.every((f) => (f.data as NestGlobalGuardsFact).calls[0] === `${(f.data as NestGlobalGuardsFact).guards[0]!.policies[0]}.canActivate`)).toBe(true);
  });

  it("follows spreads into module-level provider arrays", async () => {
    const facts = await factsOf(`import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";

const apiMiddleware = [{ provide: APP_GUARD, useClass: AuthGuard }];

@Module({ providers: [...apiMiddleware] })
export class ApiModule {}
`);
    expect(facts).toHaveLength(1);
    expect((facts[0]!.data as NestGlobalGuardsFact).guards[0]!.text).toBe("APP_GUARD(AuthGuard)");
  });

  it("ignores providers that do not use APP_GUARD", async () => {
    const facts = await factsOf(`import { Module } from "@nestjs/common";
@Module({ providers: [{ provide: "X", useClass: AuthGuard }] })
export class AppModule {}
`);
    expect(facts).toEqual([]);
  });
});

describe("NestJS useGlobalInterceptors facts", () => {
  async function factsOf(src: string): Promise<RouteFact[]> {
    const tree = await parseSource(src, "typescript" as any, "main.ts");
    const facts: RouteFact[] = [];
    collectNestGlobalInterceptors(tree.rootNode, src, facts);
    return facts;
  }

  it("records AuditInterceptor from NestFactory bootstrap, and ignores a namesake method", async () => {
    const nest = await factsOf(`import { NestFactory } from "@nestjs/core";
import { AuditInterceptor } from "./audit.interceptor";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalInterceptors(new AuditInterceptor());
}
`);
    expect(nest).toHaveLength(1);
    expect(nest[0]!.data as NestGlobalInterceptorsFact).toEqual({
      middleware: ["useGlobalInterceptors(AuditInterceptor)"],
      calls: ["AuditInterceptor.intercept"],
    });

    const decoy = await factsOf(`export class DecoyService {
  useGlobalInterceptors() { return "no"; }
}
new DecoyService().useGlobalInterceptors();
`);
    expect(decoy).toEqual([]);
  });

  it("names framework interceptors in middleware text", async () => {
    const facts = await factsOf(`import { NestFactory } from "@nestjs/core";
import { ClassSerializerInterceptor } from "@nestjs/common";
const app = await NestFactory.create(AppModule);
app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));
`);
    expect((facts[0]!.data as NestGlobalInterceptorsFact).middleware).toEqual([
      "useGlobalInterceptors(ClassSerializerInterceptor)",
    ]);
    expect((facts[0]!.data as NestGlobalInterceptorsFact).calls).toEqual(["ClassSerializerInterceptor.intercept"]);
  });
});

describe("NestJS APP_INTERCEPTOR providers", () => {
  async function factsOf(src: string): Promise<RouteFact[]> {
    const tree = await parseSource(src, "typescript" as any, "app.module.ts");
    const facts: RouteFact[] = [];
    collectNestAppInterceptors(tree.rootNode, src, facts);
    return facts;
  }

  it("records useClass registrations", async () => {
    const facts = await factsOf(`import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuditInterceptor } from "./audit.interceptor";

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
`);
    expect((facts[0]!.data as NestGlobalInterceptorsFact).middleware).toEqual(["APP_INTERCEPTOR(AuditInterceptor)"]);
    expect((facts[0]!.data as NestGlobalInterceptorsFact).calls).toEqual(["AuditInterceptor.intercept"]);
  });
});
