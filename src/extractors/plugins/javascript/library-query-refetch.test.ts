import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A query's `refetch()` runs the `queryFn` the TanStack Query hook was given, and an infinite query's page fetches
 * do too (real-repo FP): a held result (`clubsQuery.refetch()`), a destructured `refetch`, `fetchNextPage`.
 * Decoys: a project hook named `useQuery`, and a state method no option runs (`remove`).
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", "@tanstack/vue-query": "^5.0.0" } }),
  "src/api.ts": `export const listClubs = () => fetch("/api/clubs");
export const listPlayers = () => fetch("/api/players");
export const listFixtures = (page: number) => fetch("/api/fixtures?page=" + page);
export const listGarages = () => fetch("/api/garages");
`,
  "src/ClubList.vue": `<template><button @click="reload">Reload</button></template>
<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { listClubs } from "./api";
const clubsQuery = useQuery({ queryKey: ["clubs"], queryFn: listClubs });
function reload() { clubsQuery.refetch(); clubsQuery.remove(); }
</script>
`,
  "src/use-players.ts": `import { useQuery, useInfiniteQuery } from "@tanstack/vue-query";
import { listPlayers, listFixtures } from "./api";
export function usePlayers() {
  const { data, refetch } = useQuery({ queryKey: ["players"], queryFn: () => listPlayers() });
  const { fetchNextPage } = useInfiniteQuery({ queryKey: ["fixtures"], queryFn: ({ pageParam }) => listFixtures(pageParam), initialPageParam: 1, getNextPageParam: () => 2 });
  async function handleReload() { await refetch(); }
  async function handleMore() { await fetchNextPage(); }
  return { data, handleReload, handleMore };
}
`,
  "src/local-query.ts": `export function useQuery(opts: { queryFn: () => unknown }) { return { refetch: () => {} }; }
`,
  "src/GarageList.vue": `<template><button @click="reload">Reload</button></template>
<script setup lang="ts">
import { useQuery } from "./local-query";
import { listGarages } from "./api";
const garagesQuery = useQuery({ queryFn: () => listGarages() });
function reload() { garagesQuery.refetch(); }
</script>
`,
};

const linksFrom = (s: ProjectAnalysis, file: string): string[] =>
  (s.symbolLinks ?? [])
    .filter((l) => l.sourceFile === file && l.strategy !== "reference")
    .map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol}`);

describe("a TanStack query's refetch runs its queryFn", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-library-query-refetch-"));
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

  it("joins a held query's refetch, a destructured refetch and an infinite query's fetchNextPage to the queryFn", () => {
    expect(linksFrom(summary, "src/ClubList.vue")).toContain("reload -clubsQuery.refetch-> src/api.ts#listClubs");
    const rows = linksFrom(summary, "src/use-players.ts");
    expect(rows).toContain("handleReload -refetch.refetch-> src/use-players.ts#<useQuery:queryFn@4>");
    expect(rows).toContain("handleMore -fetchNextPage.fetchNextPage-> src/use-players.ts#<useInfiniteQuery:queryFn@5>");
  });

  it("joins nothing for a method no option runs, or a project hook named like the factory", () => {
    expect(linksFrom(summary, "src/ClubList.vue").filter((r) => r.includes("remove"))).toEqual([]);
    // The project's own hook is the project's: `reload` reaches its function, never the callback through a library join.
    expect(linksFrom(summary, "src/GarageList.vue").filter((r) => r.startsWith("reload ") && (r.includes("listGarages") || r.includes("<useQuery:")))).toEqual([]);
  });
});
