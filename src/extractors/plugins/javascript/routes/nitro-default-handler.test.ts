import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze as analyzeProject } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";

describe("Nitro routes whose handler is an anonymous default export", () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "league-web", dependencies: { nuxt: "^4.0.0" } }),
    "server/utils/clubs.ts": "export async function loadClubs() { return []; }",
    "server/api/clubs.get.ts": `import { loadClubs } from "../utils/clubs";
export default defineEventHandler(async (event) => {
  return await loadClubs();
});`,
    "server/api/[...].ts": `import { joinURL } from "ufo";
export default defineEventHandler(async (event) => {
  const target = joinURL(useRuntimeConfig().apiUrl, event.path);
  return proxyRequest(event, target);
});`,
  };

  it("carries the handler's calls on the route, and a handler that only forwards is no route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-nitro-default-"));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyzeProject({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const api = summary.routeMap.filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.calls.map((c) => c.name).join(",")}`);
    expect(api).toEqual(["GET /api/clubs loadClubs"]);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);
});
