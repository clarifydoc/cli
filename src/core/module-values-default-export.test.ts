import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A URL table another file exports as its default (`export default { clubs: "/api/clubs" }`, or
 * `export default urls` over a `const urls = {…}`) is read through the importer's own name for it,
 * on a client instance the way a named constant is.
 */
const FILES: Record<string, string> = {
  "web/src/client.ts": `import axios from "axios";\nexport const api = axios.create({ baseURL: "" });\n`,
  "web/src/endpoints.ts": `export default { clubs: "/api/clubs", cars: "/api/cars" };\n`,
  "web/src/more.ts": `const urls = { players: "/api/players" };\nexport default urls;\n`,
  "web/src/decoy.ts": `export default { clubs: "/api/other" };\n`,
  "web/src/service.ts": `import { api } from "./client";
import endpoints from "./endpoints";
import links from "./more";
export const listClubs = () => api.get(endpoints.clubs);
export const listPlayers = () => api.get(links.players);
`,
};

describe("a default-exported URL table", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-default-urls-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("fills a call's URL from the member of the imported default", () => {
    const targets = summary.apiCalls.filter((c) => c.filePath === "web/src/service.ts").map((c) => c.target).sort();
    expect(targets).toEqual(["/api/clubs", "/api/players"]);
  });
});
