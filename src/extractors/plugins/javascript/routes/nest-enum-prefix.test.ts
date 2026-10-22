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
