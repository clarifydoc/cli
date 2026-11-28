import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { javaKotlinRouteExtractor } from "../java-kotlin/routes/index.js";
import { inheritedControllerRoutes } from "./inherited-routes.js";
import { javascriptRouteExtractor } from "../javascript/routes/index.js";
import { nestInheritedRoutes } from "../javascript/routes/nestjs.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import { buildImportIndex, resolveImportSource } from "../../../core/import-index.js";
import { buildClassIndex } from "../../../core/class-index.js";
import type { FileAnalysis, Language, RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteExtractor } from "../../routes/base.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

async function analyze(language: Language, extractor: RouteExtractor, resolver: RouteResolver, files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, language as never, filePath);
    const facts: RouteFact[] = [];
    out.push({
      filePath,
      language,
      projectId: "root",
      imports: extractImports(tree, src, language as never),
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, language as never),
      routes: extractor.extractRoutes(tree, src, filePath, facts),
      routeFacts: facts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const known = new Set(out.map((a) => a.filePath));
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(out, importIndex),
    resolveModule: (from, spec) => resolveImportSource(from, spec, known),
    fileOf: (p) => out.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(out, ctx, [resolver]);
  return out;
}


const spring = inheritedControllerRoutes("spring-inherited-routes", ["java"], { overrideKeepsRoute: true });

const rows = (out: FileAnalysis[]) =>
  out.flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).sort();

const nest = (files: Record<string, string>) => analyze("typescript", javascriptRouteExtractor, nestInheritedRoutes, files);

describe("NestJS handlers inherited from a base controller", () => {
  it("serves a same-file base's handlers under the subclass prefix, none for the base alone", async () => {
    const out = await nest({
      "src/club.controller.ts": `
import { Controller, Get, Post } from '@nestjs/common';
class BaseClubController { @Get('list') list() {} @Post('sign') sign() {} }
@Controller('clubs') export class ClubController extends BaseClubController { @Get('own') own() {} }
@Controller('cars') export class CarController { @Get('x') x() {} }
`,
    });
    expect(rows(out)).toEqual(["GET /cars/x x", "GET /clubs/list list", "GET /clubs/own own", "POST /clubs/sign sign"]);
  });

  it("gives each route once per prefix for two subclasses of one imported base", async () => {
    const out = await nest({
      "src/base.ts": `import { Get } from '@nestjs/common';\nexport class BaseClubController { @Get('list') list() {} }\n`,
      "src/a.controller.ts": `import { Controller } from '@nestjs/common';\nimport { BaseClubController } from './base';\n@Controller('clubs') export class ClubController extends BaseClubController {}\n`,
      "src/b.controller.ts": `import { Controller } from '@nestjs/common';\nimport { BaseClubController } from './base';\n@Controller('teams') export class TeamController extends BaseClubController {}\n`,
    });
    expect(rows(out)).toEqual(["GET /clubs/list list", "GET /teams/list list"]);
  });

  it("reads an abstract generic base", async () => {
    const out = await nest({
      "src/crud.ts": `import { Get, Delete } from '@nestjs/common';\nexport abstract class CrudController<T> { @Get(':id') one() {} @Delete(':id') remove() {} }\n`,
      "src/player.controller.ts": `import { Controller } from '@nestjs/common';\nimport { CrudController } from './crud';\n@Controller('players') export class PlayerController extends CrudController<Player> {}\n`,
    });
    expect(rows(out)).toEqual(["DELETE /players/:id remove", "GET /players/:id one"]);
  });

  it("mounts nothing for a handler the subclass redeclares without a route decorator", async () => {
    const out = await nest({
      "src/club.controller.ts": `
import { Controller, Get } from '@nestjs/common';
class BaseClubController { @Get('list') list() {} @Get('gone') gone() {} }
@Controller('clubs') export class ClubController extends BaseClubController { gone() {} }
`,
    });
    expect(rows(out)).toEqual(["GET /clubs/list list"]);
  });

  it("keeps a controller base's own routes and adds the subclass's", async () => {
    const out = await nest({
      "src/club.controller.ts": `
import { Controller, Get } from '@nestjs/common';
@Controller('clubs') export class ClubController { @Get('list') list() {} }
@Controller('youth') export class YouthController extends ClubController {}
`,
    });
    expect(rows(out)).toEqual(["GET /clubs/list list", "GET /youth/list list"]);
  });

  it("adds the subclass's own @UseGuards to the copy", async () => {
    const out = await nest({
      "src/club.controller.ts": `
import { Controller, Get, UseGuards } from '@nestjs/common';
class BaseClubController { @Get('list') list() {} }
@Controller('clubs') @UseGuards(StewardGuard) export class ClubController extends BaseClubController {}
`,
    });
    const route = out[0]!.routes.find((r) => r.path === "/clubs/list")!;
    expect(route.middleware.join(" ")).toContain("StewardGuard");
  });
});

describe("Spring handlers inherited from a base controller", () => {
  const BASE = `
package com.example.league;
import org.springframework.web.bind.annotation.*;
public abstract class BaseClubController {
  @GetMapping("/list") public String list() { return ""; }
  @PostMapping("/sign") public String sign() { return ""; }
}
`;
  const sub = (name: string, prefix: string, body = "") => `
package com.example.league;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("${prefix}")
public class ${name} extends BaseClubController { ${body} }
`;

  it("serves an abstract base's handlers under each subclass's @RequestMapping, none for the base", async () => {
    const out = await analyze("java", javaKotlinRouteExtractor, spring, {
      "src/BaseClubController.java": BASE,
      "src/ClubController.java": sub("ClubController", "/clubs", `@GetMapping("/own") public String own() { return ""; }`),
      "src/CarController.java": sub("CarController", "/cars"),
    });
    expect(rows(out)).toEqual([
      "GET /cars/list list",
      "GET /clubs/list list",
      "GET /clubs/own own",
      "POST /cars/sign sign",
      "POST /clubs/sign sign",
    ]);
  });

  it("keeps the inherited route for an override with no annotation, takes the subclass's own mapping otherwise", async () => {
    const out = await analyze("java", javaKotlinRouteExtractor, spring, {
      "src/BaseClubController.java": BASE,
      "src/ClubController.java": sub("ClubController", "/clubs", `@Override public String list() { return "x"; } @PostMapping("/signing") public String sign() { return ""; }`),
    });
    expect(rows(out)).toEqual(["GET /clubs/list list", "POST /clubs/signing sign"]);
  });

  it("keeps the functional routes of a plain class (real-repo FP: they were dropped as an unmounted base)", async () => {
    const out = await analyze("java", javaKotlinRouteExtractor, spring, {
      "src/ClubRoutes.java": `
package com.example.league;
import org.springframework.web.reactive.function.server.RouterFunctions;
class ClubRoutes {
  ClubRoutes() { RouterFunctions.route().GET("/clubs", this::list).build(); }
}
`,
    });
    expect(rows(out)).toEqual(["GET /clubs list"]);
  });
});
