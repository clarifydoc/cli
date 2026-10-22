import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Real-repo FP: an Angular template's `<a href="/library/{{id}}/series/{{sid}}">` recorded as an API call. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-ui", dependencies: { "@angular/core": "17.0.0", "@angular/router": "17.0.0" } }),
  "src/app/app.routes.ts": `import { Routes } from "@angular/router";
import { ClubDetailComponent } from "./club-detail.component";
export const routes: Routes = [
  { path: "league/:leagueId/club/:clubId", component: ClubDetailComponent },
];
`,
  "src/app/club-detail.component.ts": `import { Component } from "@angular/core";
@Component({ selector: "app-club-detail", templateUrl: "./club-detail.component.html" })
export class ClubDetailComponent {}
`,
  "src/app/club-detail.component.html": `<a class="title-link" href="/league/{{club.leagueId}}/club/{{club.id}}">{{club.name}}</a>
<a href="/downloads/fixtures">Fixtures</a>
`,
};

describe("a single-page app's own links", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-spa-links-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are navigation to its client routes, not requests", () => {
    const calls = (summary.apiCalls ?? []).filter((c) => c.filePath.endsWith(".html")).map((c) => c.target);
    expect(calls).toEqual(["/downloads/fixtures"]);
  });
});
