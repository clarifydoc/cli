import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/** Real-repo FP: `@Controller(RouteKey.Asset)` — 45 routes at `/` paths, real ones shadowed by dedupe. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-server", dependencies: { "@nestjs/common": "10.0.0", "@nestjs/core": "10.0.0" } }),
  "src/enum.ts": `export enum RouteKey {
  Club = 'clubs',
  Player = 'players',
}
`,
  "src/controllers/club.controller.ts": `import { Controller, Get, Post, Param } from '@nestjs/common';
import { RouteKey } from '../enum';

@Controller(RouteKey.Club)
export class ClubController {
  @Get('statistics')
  statistics() {}

  @Get(':id')
  get(@Param('id') id: string) {}

  @Post('jobs')
  runJobs() {}
}
`,
  "src/controllers/player.controller.ts": `import { Controller, Get, Param } from '@nestjs/common';
import { RouteKey } from '../enum';

@Controller(RouteKey.Player)
export class PlayerController {
  @Get(':id')
  get(@Param('id') id: string) {}
}
`,
  "src/controllers/job.controller.ts": `import { Controller, Post } from '@nestjs/common';

@Controller('jobs')
export class JobController {
  @Post()
  create() {}
}
`,
};

describe("a NestJS controller prefixed by an enum member", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-nest-enum-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each route under the member's value, and nothing shadows another controller's route", () => {
    const routes = summary.routeMap.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort();
    expect(routes).toEqual([
      "GET /clubs/:id get",
      "GET /clubs/statistics statistics",
      "GET /players/:id get",
      "POST /clubs/jobs runJobs",
      "POST /jobs create",
    ]);
  });
});

const CONTROLLER = `import { Controller, Get } from '@nestjs/common';
import { RouteKey } from '@league/shared/enum';

@Controller(RouteKey.Club)
export class ClubController {
  @Get('statistics')
  statistics() {}
}
`;
const ENUM = `export enum RouteKey {
  Club = 'clubs',
}
`;
const NEST_PKG = (name: string) => JSON.stringify({ name, dependencies: { "@nestjs/common": "10.0.0", "@nestjs/core": "10.0.0" } });

async function paths(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "cd-nest-enum-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    return summary.routeMap.filter((r) => r.kind === "api").map((r) => r.path).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("an enum reference behind an import the resolver cannot follow", () => {
  it("is filled from the one enum of that name in the sub-project", async () => {
    expect(await paths({ "package.json": NEST_PKG("league"), "src/a/enum.ts": ENUM, "src/club.controller.ts": CONTROLLER })).toEqual(["/clubs/statistics"]);
  }, 180_000);

  it("is filled from a project's one enum file however many members its other enums have (real-repo FP)", async () => {
    const kits = `export enum KitColour {\n${Array.from({ length: 150 }, (_, i) => `  Shade${i} = 'shade-${i}',`).join("\n")}\n}\n`;
    expect(await paths({ "package.json": NEST_PKG("league"), "src/enum.ts": kits + ENUM, "src/club.controller.ts": CONTROLLER.replace("@league/shared/enum", "src/enum.js") })).toEqual(["/clubs/statistics"]);
  }, 180_000);

  it("is left alone when two modules declare that enum name", async () => {
    const got = await paths({ "package.json": NEST_PKG("league"), "src/a/enum.ts": ENUM, "src/b/enum.ts": ENUM.replace("clubs", "teams"), "src/club.controller.ts": CONTROLLER });
    expect(got).not.toContain("/clubs/statistics");
    expect(got).not.toContain("/teams/statistics");
  }, 180_000);

  it("is left alone when the file imports that name from a module the table is not in", async () => {
    const got = await paths({ "package.json": NEST_PKG("league"), "src/a/enum.ts": ENUM, "src/club.controller.ts": CONTROLLER.replace("@league/shared/enum", "route-kit") });
    expect(got).not.toContain("/clubs/statistics");
  }, 180_000);

  it("is left alone when only another sub-project declares the enum", async () => {
    const got = await paths({
      "api/package.json": NEST_PKG("league-api"),
      "api/src/club.controller.ts": CONTROLLER,
      "web/package.json": JSON.stringify({ name: "league-web" }),
      "web/src/enum.ts": ENUM,
    });
    expect(got).not.toContain("/clubs/statistics");
  }, 180_000);
});
