import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Writes that re-run a query built from a ref: an inline template write into an index of a ref holding a
 * record (`(n) => pages[club.id] = n`, generics nested in the `ref<…>` declaration), and a debounced function
 * given by name (`const onSearch = useDebounceFn(applySearch, 300)`). Invented names; labels by hand.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0", "@tanstack/vue-query": "^5.0.0", "@vueuse/core": "^10.0.0" } }),
  "src/queries/players.ts": `import axios from "axios";
export const playersQuery = (clubId: string, page: number) => ({
  queryKey: ["players", clubId, page],
  queryFn: () => axios.get(\`/api/clubs/\${clubId}/players\`, { params: { page } }),
});
export const clubsQuery = (search: string) => ({
  queryKey: ["clubs", search],
  queryFn: () => axios.get("/api/clubs", { params: { search } }),
});
`,
  "src/pages/Pager.vue": `<template><button @click="$emit('page-changed', 2)">Next</button></template>\n`,
  "src/pages/PlayerLists.vue": `<template>
  <div v-for="club in clubs" :key="club.id">
    <Pager @page-changed="(n) => pages[club.id] = n" />
  </div>
</template>
<script setup lang="ts">
import { ref, computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { playersQuery } from "../queries/players";
import Pager from "./Pager.vue";
const clubs = [{ id: "a" }];
const pages = ref<Record<string, number>>({});
const { data } = useQuery(computed(() => playersQuery("a", pages.value["a"])));
</script>
`,
  "src/pages/ClubSearch.vue": `<template><input @input="onSearch($event.target.value)" /></template>
<script setup lang="ts">
import { ref, computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useDebounceFn } from "@vueuse/core";
import { clubsQuery } from "../queries/players";
const search = ref("");
const { data } = useQuery(computed(() => clubsQuery(search.value)));
function applySearch(term: string) { search.value = term; }
const onSearch = useDebounceFn(applySearch, 300);
</script>
`,
};

describe("writes that re-run a query", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-query-writes-"));
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

  const calls = (file: string) => summary.symbolLinks.filter((l) => l.sourceFile === file && l.relation !== "reference").map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);

  it("reads an index write of an inline handler as the trigger of the query its ref feeds", () => {
    expect(calls("src/pages/PlayerLists.vue").some((l) => /playersQuery -> playersQuery$/.test(l))).toBe(true);
  });

  it("makes a debounced function given by name a function that calls it", () => {
    expect(calls("src/pages/ClubSearch.vue")).toContain("onSearch applySearch -> applySearch");
  });
});
