import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A Svelte component reads its TanStack table through the store's auto-subscription (`$table.nextPage()`): the call
 * runs the `onPaginationChange` the component wrote, and nothing else of the project that shares a name with it.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { svelte: "^4.2.0", "@tanstack/svelte-table": "^8.20.0", axios: "^1.6.0" } }),
  "src/decoy.js": `import axios from 'axios';
export function loadPage() { return axios.delete('/api/v2/decoy-load'); }
export function nextPage() { return axios.delete('/api/v2/decoy-next'); }
`,
  "src/Standings.svelte": `<script>
  import { createSvelteTable } from '@tanstack/svelte-table';
  import axios from 'axios';
  export let rows = [];
  function loadPage(update) { axios.get('/api/v2/standings-page'); }
  const table = createSvelteTable({ data: rows, columns: [], onPaginationChange: loadPage });
  function next() { $table.nextPage(); }
  function reload() { $standings.nextPage(); }
</script>
<button on:click={next}>next</button>
`,
};

describe("a Svelte table store's methods", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-svelte-table-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the pagination callback written in the component", () => {
    const reached = summary.symbolLinks.filter((l) => l.sourceFile === "src/Standings.svelte" && l.strategy === "dispatch:library-option").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}:${l.targetSymbol}`);
    expect(reached).toEqual(["next -table.nextPage-> src/Standings.svelte:loadPage"]);
  });
  it("links no store of another name, and nothing into the namesake decoy", () => {
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol === "reload" && l.relation !== "reference")).toEqual([]);
    expect(summary.symbolLinks.filter((l) => l.targetFile === "src/decoy.js")).toEqual([]);
  });
});
