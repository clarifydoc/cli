import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractNestjsRoutes } from "./nestjs.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "users.controller.ts");
  const routes: RouteInfo[] = [];
  extractNestjsRoutes(tree.rootNode, routes);
  return routes;
}

const CONTROLLER = `import { Controller, Get, Post, Body, Param, Query, Headers, Req, UseGuards, Version } from '@nestjs/common';

@Controller('users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  @Roles('admin', 'editor')
  findOne(@Param('id') id: string, @Query('q') q?: string, @Headers('x-tenant') tenant: string, @Req() req: Request) {
    return this.users.find(id);
  }

  @Post()
  @Version('2')
  create(@Body() dto: CreateUserDto, plain: number) {
    return this.users.create(dto);
  }

  @Public()
  @Get()
  list(@Query() filter: ListUsersQuery) {
    return this.users.list(filter);
  }

  @Post(':id/avatar')
  upload(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body('caption') caption: string) {}
}
`;

describe("NestJS routes — handler and prefix", () => {
  it("names the decorated method as handler, not the first method in the class", async () => {
    const routes = await routesOf(CONTROLLER);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /users/:id -> findOne",
      "POST /users -> create",
      "GET /users -> list",
      "POST /users/:id/avatar -> upload",
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
      { name: "dto", type: "CreateUserDto", binding: "body" },
      { name: "plain", type: "number", binding: null },
    ]);
    expect(routes.find((r) => r.handler === "list")!.params).toEqual([
      { name: "filter", type: "ListUsersQuery", binding: "query" },
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
