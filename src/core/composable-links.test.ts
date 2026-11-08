import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Values a composable hands out (Options-API `setup()` returns) and takes in (parameters bound at its call sites). */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "league-ui", "dependencies": { "vue": "^3.4.0", "axios": "^1.0.0" } }\n`,
  "src/composables/useSquad.ts": `import axios from 'axios';
export function useSquad() {
  async function save(club: string) { return axios.post('/api/clubs', { club }); }
  function reset() { return axios.delete('/api/clubs/reset'); }
  return { save, reset };
}
`,
  "src/composables/useRival.ts": `import axios from 'axios';
export function useRival() {
  async function save(x: string) { return axios.post('/api/rivals', { x }); }
  return { save };
}
`,
  "src/composables/usePlayers.ts": `import axios from 'axios';
export function usePlayers() {
  function updateItem(id: number) { return axios.put('/api/players/' + id); }
  return { updateItem };
}
`,
  "src/composables/useTableSort.ts": `export function useTableSort(sortBy: any, onChange: () => void) {
  function sort(col: string) { sortBy.value = col; onChange(); }
  return { sort };
}
`,
  "src/composables/useCrud.ts": `export function useCrud(actions: any, refresh: () => void) {
  function rename(id: number) { actions.updateItem(id); refresh(); }
  return { rename };
}
`,
  "src/composables/useDialog.ts": `export function useDialog(items: any[], onSave: (x: any) => void) {
  function saveAll() { onSave(items); }
  return { saveAll };
}
`,
  "src/composables/useFilter.ts": `export function useFilter(term: any, onChange: () => void) {
  function apply(v: string) { term.value = v; onChange(); }
  return { apply };
}
`,
  "src/views/Options.vue": `<template><button @click="doReset">Reset</button></template>
<script>
import { useSquad } from '../composables/useSquad';
export default {
  setup() { const squad = useSquad(); return { squad, doReset: squad.reset }; },
  methods: { go() { this.squad.save('b'); } }
};
</script>
`,
  "src/views/Table.vue": `<template><button @click="sort('name')">Sort</button><button @click="rename(1)">Rename</button><button @click="saveAll()">All</button></template>
<script setup lang="ts">
import { ref } from 'vue';
import axios from 'axios';
import { useTableSort } from '../composables/useTableSort';
import { useCrud } from '../composables/useCrud';
import { usePlayers } from '../composables/usePlayers';
import { useDialog } from '../composables/useDialog';
const sortBy = ref('');
function reloadClubs() { axios.get('/api/clubs'); }
const { sort } = useTableSort(sortBy, reloadClubs);
const playerActions = usePlayers();
const { rename } = useCrud(playerActions, reloadClubs);
const { saveAll } = useDialog([], (x) => announce(x));
function announce(x: any) { axios.post('/api/matches', x); }
function update(patch: any, mutation = playerActions) { mutation.updateItem(1); }
</script>
`,
  // The same composable called with two different collaborators: nothing is stated once.
  "src/views/Standings.vue": `<template><button @click="sort('points')">Sort</button></template>
<script setup lang="ts">
import { ref } from 'vue';
import { useTableSort } from '../composables/useTableSort';
const order = ref('');
function reloadStandings() {}
const { sort } = useTableSort(order, reloadStandings);
</script>
`,
  "src/views/TwoTables.vue": `<template><button @click="sort2('name')">Sort</button></template>
<script setup lang="ts">
import { ref } from 'vue';
import { useFilter } from '../composables/useFilter';
const a = ref('');
function reloadPlayers() {}
function reloadRivals() {}
const { apply: sort2 } = useFilter(a, reloadPlayers);
const other = useFilter(a, reloadRivals);
</script>
`,
};

describe("composables: returned names and bound parameters", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-composables-"));
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

  const hop = (file: string, symbol: string, call: string): string[] =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && l.callName === call)
      .map((l) => `${l.targetFile.split("/").pop()}::${l.targetSymbol}`).sort();

  it("links this.x.method() and a renamed returned member to the composable's function, not a namesake", () => {
    expect(hop("src/views/Options.vue", "go", "this.squad.save")).toEqual(["useSquad.ts::save"]);
    expect(hop("src/views/Options.vue", "<setup>", "doReset")).toEqual(["useSquad.ts::reset"]);
  });

  it("follows a callback argument into the composable's body", () => {
    expect(hop("src/composables/useCrud.ts", "rename", "refresh")).toEqual(["Table.vue::reloadClubs"]);
  });

  it("gives each screen its own callback when the composable's call sites differ", () => {
    // useTableSort is called with reloadClubs in one screen and reloadStandings in another: no single
    // target for `onChange`, but each screen's `sort(…)` runs the callback ITS call handed over.
    expect(hop("src/composables/useTableSort.ts", "sort", "onChange")).toEqual([]);
    expect(hop("src/views/Table.vue", "<setup>", "sort")).toEqual(["Table.vue::reloadClubs", "useTableSort.ts::sort"]);
    expect(hop("src/views/Standings.vue", "<setup>", "sort")).toEqual(["Standings.vue::reloadStandings", "useTableSort.ts::sort"]);
  });

  it("follows a member of another composable's result handed in as an untyped parameter", () => {
    expect(hop("src/composables/useCrud.ts", "rename", "actions.updateItem")).toEqual(["usePlayers.ts::updateItem"]);
  });

  it("follows a callback arrow's one call", () => {
    expect(hop("src/composables/useDialog.ts", "saveAll", "onSave")).toEqual(["Table.vue::announce"]);
  });

  it("follows a parameter's default binding", () => {
    expect(hop("src/views/Table.vue", "update", "mutation.updateItem")).toEqual(["usePlayers.ts::updateItem"]);
  });

  it("links nothing for a parameter two call sites state differently", () => {
    expect(hop("src/composables/useFilter.ts", "apply", "onChange")).toEqual([]);
  });
});
