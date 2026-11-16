import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A base class reads its `url` getter edited by `.replace` and a subclass overrides the getter:
 * the request, as seen from the subclass, is that subclass's URL edited — as the plain
 * `${this.url}` read already is.
 */
describe("an edited URL getter a subclass overrides", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-url-edit-overrides-"));
    const web = join(dir, "web", "src");
    await mkdir(web, { recursive: true });
    await writeFile(join(dir, "web", "package.json"), JSON.stringify({ name: "league-web", dependencies: { axios: "1.6.0" } }));
    await writeFile(join(web, "base.js"), [
      "export class BaseApi {",
      "  get url() { return '/api/base/:id'; }",
      "  list() { return axios.get(this.url.replace('/:id', '')); }",
      "  one() { return axios.get(`${this.url.replace(':id', '7')}/stats`); }",
      "  plain() { return axios.get(`${this.url}/x`); }",
      "}",
    ].join("\n"));
    await writeFile(join(web, "clubs.js"), [
      "import { BaseApi } from './base';",
      "export class ClubApi extends BaseApi {",
      "  get url() { return '/api/clubs/:id'; }",
      "}",
      "export class PlayerApi extends BaseApi {",
      "  get url() { return '/api/players/:id'; }",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (line: number): string[] =>
    (summary.apiCalls ?? []).filter((c) => c.filePath === "web/src/base.js" && c.line === line).map((c) => `${c.target} ${c.viaSubclass ?? ""}`.trim()).sort();

  it("reads the subclass's getter for the edited form, as for the plain one", () => {
    expect(rows(5)).toEqual(["/api/clubs/:id/x ClubApi", "/api/players/:id/x PlayerApi"]);
    expect(rows(3)).toEqual(["/api/clubs ClubApi", "/api/players PlayerApi"]);
    expect(rows(4)).toEqual(["/api/clubs/7/stats ClubApi", "/api/players/7/stats PlayerApi"]);
  });
});
