import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { SymbolLink } from "../types/analysis.js";

/**
 * A callback written in place and held as a function of its own (`<watch@7>`, `<kit.action@4>`) closes over a
 * local the function around it types by an initializer call (`const clubStore = useClubStore()`). The call is
 * written in the outer function, not the callback, so it is looked up there: the receiver keeps the store's type
 * inside the callback, as it had when the calls were the outer function's own.
 */
describe("a held callback's receiver typed by the enclosing function's initializer, end to end", () => {
  let dir: string;
  let links: SymbolLink[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-held-init-"));
    const root = join(dir, "repo");
    for (const d of ["src/stores", "src/composables"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", pinia: "2.1.0" } }));
    await writeFile(join(root, "src/stores/clubs.ts"), [
      "import { defineStore } from 'pinia'",
      "import { ref } from 'vue'",
      "export const useClubStore = defineStore('clubs', () => {",
      "  const list = ref<string[]>([])",
      "  function setQuery(q: string) { list.value = [q] }",
      "  function clearQuery() { list.value = [] }",
      "  return { list, setQuery, clearQuery }",
      "})",
    ].join("\n"));
    await writeFile(join(root, "src/stores/garage.ts"), [
      "export function setQuery(q: string) { return q }",
      "export function clearQuery() { return '' }",
    ].join("\n"));
    await writeFile(join(root, "src/composables/useFilters.ts"), [
      "import { ref } from 'vue'",
      "export function useFilters() {",
      "  const filters = ref('')",
      "  function setFilters(v: string) { filters.value = v }",
      "  return { filters, setFilters }",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/composables/useLeague.ts"), [
      "import { watch } from 'vue'",
      "import { useClubStore } from '../stores/clubs'",
      "import { useFilters } from './useFilters'",
      "export function useLeague(kit: { action?: () => void }) {",
      "  const clubStore = useClubStore()",
      "  const { filters, setFilters } = useFilters()",
      "  watch(filters, (q) => {",
      "    if (q) clubStore.setQuery(q)",
      "    else clubStore.clearQuery()",
      "  })",
      "  kit.action = () => clubStore.clearQuery()",
      "  return { filters, setFilters }",
      "}",
    ].join("\n"));
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    links = (await loadReportSummary(out)).symbolLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const from = (symbol: RegExp, call: string): SymbolLink[] =>
    links.filter((l) => l.sourceFile === "src/composables/useLeague.ts" && symbol.test(l.sourceSymbol) && l.callName === call);

  it("types the store receiver inside the watch callback", () => {
    for (const call of ["clubStore.setQuery", "clubStore.clearQuery"]) {
      const rows = from(/^<watch@\d+>$/, call);
      expect(rows.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toContain(`src/stores/clubs.ts::ClubStore.${call.split(".")[1]}`);
    }
  });

  it("types it inside a callback assigned to a property", () => {
    const rows = from(/^<kit\.action@\d+>$/, "clubStore.clearQuery");
    expect(rows.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toContain("src/stores/clubs.ts::ClubStore.clearQuery");
  });

  it("never reaches the namesake functions of another module", () => {
    expect(links.filter((l) => l.sourceFile === "src/composables/useLeague.ts" && l.targetFile === "src/stores/garage.ts")).toEqual([]);
  });
});
