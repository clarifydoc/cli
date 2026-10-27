import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import { extractImports } from "../../imports-exports/index.js";
import { javaKotlinRouteExtractor } from "../java-kotlin/routes/index.js";
import { javascriptRouteExtractor } from "../javascript/routes/index.js";
import { nestInheritedGuards } from "../javascript/routes/nestjs.js";
import { inheritedClassGuards } from "./class-guards.js";
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

const rows = (out: FileAnalysis[]) =>
  out.flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.middleware.join(" | ")}`)).sort();

describe("class-level guards inherited from a base class in another file", () => {
  it("Spring: a controller without its own class guard takes its base's @PreAuthorize; one with its own keeps it", async () => {
    const out = await analyze("java", javaKotlinRouteExtractor, inheritedClassGuards("jvm-inherited-guards", ["java"]), {
      "src/main/java/com/example/league/SecuredController.java": `
package com.example.league;
@PreAuthorize("hasRole('STEWARD')")
public abstract class SecuredController {}
`,
      "src/main/java/com/example/league/ClubController.java": `
package com.example.league;
@RestController
@RequestMapping("/api/clubs")
public class ClubController extends SecuredController {
    @GetMapping("/{id}")
    public Club get(@PathVariable Long id) { return null; }
}
`,
      "src/main/java/com/example/league/FixtureController.java": `
package com.example.league;
@RestController
@RequestMapping("/api/fixtures")
@PreAuthorize("permitAll()")
public class FixtureController extends SecuredController {
    @GetMapping
    public List<Fixture> list() { return null; }
}
`,
    });
    expect(rows(out)).toEqual([
      `GET /api/clubs/{id} PreAuthorize("hasRole('STEWARD')")`,
      `GET /api/fixtures PreAuthorize("permitAll()")`,
    ]);
  });

  it("NestJS: @UseGuards on a base controller guards the routes of its subclasses", async () => {
    const out = await analyze("typescript", javascriptRouteExtractor, nestInheritedGuards, {
      "src/common/base.controller.ts": `
import { UseGuards } from '@nestjs/common';
@UseGuards(AuthGuard('jwt'))
export abstract class BaseController {}
`,
      "src/clubs/clubs.controller.ts": `
import { Controller, Get } from '@nestjs/common';
import { BaseController } from '../common/base.controller';
@Controller('clubs')
export class ClubsController extends BaseController {
  @Get(':id')
  findOne() { return null; }
}
`,
    });
    expect(rows(out)).toEqual(["GET /clubs/:id UseGuards(AuthGuard('jwt'))"]);
    expect(out[1]!.routes[0]!.auth?.schemes).toEqual(["jwt"]);
  });
});
