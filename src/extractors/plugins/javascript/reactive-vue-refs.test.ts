import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Vue refs that stand for another cell: a `computed` a watcher reads, `toRefs` / `toRef` onto a reactive object (and
 * onto the component's props), and a Pinia store's state through `storeToRefs`, the instance or `$patch`. A write to
 * the original runs the watcher on the alias and the other way round; a ref onto another member, or onto another
 * object, runs nothing. Labels written by hand from the sources below.
 */
const COMPUTED = `<template><button @click="page = 2">Next</button><button @click="setSize(5)">Size</button></template>
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import axios from "axios";
const page = ref(1);
const size = ref(10);
const unrelated = ref(0);
const total = computed(() => page.value * size.value);
const doubled = computed(() => total.value * 2);
function setSize(n: number) { size.value = n; }
function touch() { unrelated.value++; }
watch(doubled, () => { axios.get("/api/standings"); });
</script>
`;

const TO_REFS = `<template><button @click="page = 2">Next</button><button @click="setLeague(3)">League</button></template>
<script setup lang="ts">
import { reactive, toRefs, toRef, watch } from "vue";
import axios from "axios";
const state = reactive({ page: 1, size: 10, league: 1 });
const other = reactive({ page: 1 });
const { page, size: perPage } = toRefs(state);
const league = toRef(state, "league");
function goSize(n: number) { state.size = n; }
function setLeague(n: number) { league.value = n; }
function otherPage(n: number) { other.page = n; }
function setPage(n: number) { page.value = n; }
watch(page, () => { axios.get("/api/fixtures"); });
watch(perPage, () => { axios.get("/api/clubs"); });
watch(() => state.league, () => { axios.get("/api/players"); });
</script>
`;

const PROP_REFS = `<template><ClubTable :page="current" /></template>
<script setup lang="ts">
import { ref } from "vue";
import ClubTable from "./ClubTable.vue";
const current = ref(1);
function next() { current.value++; }
</script>
`;

const CLUB_TABLE = `<template><div>{{ page }}</div></template>
<script setup lang="ts">
import { toRefs, toRef, watch } from "vue";
import axios from "axios";
const props = defineProps<{ page: number; size: number }>();
const { page } = toRefs(props);
const size = toRef(props, "size");
watch(page, () => { axios.get("/api/bench"); });
watch(size, () => { axios.get("/api/cars"); });
</script>
`;

const STORE = `import { defineStore } from "pinia";
import { ref } from "vue";
export const useFilterStore = defineStore("filters", () => {
  const page = ref(1);
  const league = ref(0);
  function reset() { page.value = 1; }
  return { page, league, reset };
});
export const useOtherStore = defineStore("other", () => {
  const page = ref(1);
  return { page };
});
`;

const WATCHER = `<template><button @click="page = 2">Next</button><button @click="bump()">Bump</button></template>
<script setup lang="ts">
import { watch } from "vue";
import { storeToRefs } from "pinia";
import axios from "axios";
import { useFilterStore } from "./stores/filters";
const store = useFilterStore();
const { page } = storeToRefs(store);
function bump() { page.value = page.value + 1; }
watch(page, () => { axios.get("/api/drivers"); });
</script>
`;

const WRITER = `<template><button @click="go()">Go</button><button @click="store.page = 7">Seven</button></template>
<script setup lang="ts">
import { useFilterStore, useOtherStore } from "./stores/filters";
const store = useFilterStore();
const other = useOtherStore();
function go() { store.page = 4; }
function patch() { store.$patch({ page: 5 }); }
function patchFn() { store.$patch((state) => { state.page = 6; }); }
function leagueOnly() { store.league = 3; }
function elsewhere() { other.page = 9; }
</script>
`;

const DIRECT = `<template><button @click="clear()">Clear</button></template>
<script setup lang="ts">
import { useFilterStore } from "./stores/filters";
function clear() { useFilterStore().$patch({ page: 1 }); }
</script>
`;

const FILES: Record<string, string> = {
  "web/src/Direct.vue": DIRECT,
  "api/server.js": `const express = require("express");
const app = express();
for (const p of ["standings", "fixtures", "clubs", "players", "bench", "cars", "drivers"]) app.get("/api/" + p, (req, res) => res.json([]));
`,
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", pinia: "^2.0.0" } }),
  "web/src/Computed.vue": COMPUTED,
  "web/src/ToRefs.vue": TO_REFS,
  "web/src/PropRefs.vue": PROP_REFS,
  "web/src/ClubTable.vue": CLUB_TABLE,
  "web/src/stores/filters.ts": STORE,
  "web/src/Watcher.vue": WATCHER,
  "web/src/Writer.vue": WRITER,
};

const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("Vue refs standing for another cell", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  const links = () => (summary.symbolLinks ?? []).filter((l) => l.strategy === "dispatch:reactive-trigger" || l.strategy === "dispatch:store-watch" || l.strategy === "dispatch:prop-flow").map((l) => `${l.sourceFile}::${l.sourceSymbol} --${l.callName}--> ${l.targetSymbol}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-vue-refs-"));
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

  it("runs a watcher on a computed when a ref it reads, through another computed, is written", () => {
    const f = "web/src/Computed.vue";
    const onDoubled = `<watch@${lineOf(COMPUTED, "watch(doubled")}>`;
    expect(links()).toEqual(expect.arrayContaining([`${f}::<setup> --page--> ${onDoubled}`, `${f}::setSize --size--> ${onDoubled}`]));
    expect(links().join("\n")).not.toContain("::touch");
  });

  it("joins a ref made by toRefs or toRef to the member of the reactive object it stands for", () => {
    const f = "web/src/ToRefs.vue";
    const onPage = `<watch@${lineOf(TO_REFS, "watch(page")}>`;
    const onSize = `<watch@${lineOf(TO_REFS, "watch(perPage")}>`;
    const onLeague = `<watch@${lineOf(TO_REFS, "watch(() => state.league")}>`;
    expect(links()).toEqual(expect.arrayContaining([
      // the template's `page = 2` and `page.value = n` write `state.page`, which `watch(page)` reads
      `${f}::<setup> --page--> ${onPage}`,
      `${f}::setPage --page--> ${onPage}`,
      // a write of the original runs the watcher on the alias
      `${f}::goSize --state--> ${onSize}`,
      // a write through the alias runs a watcher on the original
      `${f}::setLeague --league--> ${onLeague}`,
    ]));
    // another reactive object's `page` is another cell
    expect(links().join("\n")).not.toContain("::otherPage");
  });

  it("runs a watcher on a ref onto a prop when the parent changes the bound value", () => {
    const parent = "web/src/PropRefs.vue";
    expect(links()).toEqual(expect.arrayContaining([
      `${parent}::next --current--> <watch@${lineOf(CLUB_TABLE, "watch(page")}>`,
    ]));
    // `size` is bound by nobody
    expect(links().filter((l) => l.startsWith(parent))).toEqual([`${parent}::next --current--> <watch@${lineOf(CLUB_TABLE, "watch(page")}>`]);
  });

  it("joins a component's write of store state — through a ref, the instance, $patch — to the watchers of that store", () => {
    const watcher = "web/src/Watcher.vue";
    const writer = "web/src/Writer.vue";
    const onPage = `${watcher}::<watch@${lineOf(WATCHER, "watch(page")}>`;
    const all = links();
    expect(all).toEqual(expect.arrayContaining([
      `${watcher}::bump --page--> ${onPage.split("::")[1]}`,
      `${watcher}::<setup> --page--> ${onPage.split("::")[1]}`,
      `${writer}::go --page--> ${onPage.split("::")[1]}`,
      `${writer}::patch --page--> ${onPage.split("::")[1]}`,
      `${writer}::patchFn --page--> ${onPage.split("::")[1]}`,
      `${writer}::<setup> --page--> ${onPage.split("::")[1]}`,
      // no local holds the store: the call is the store
      `web/src/Direct.vue::clear --page--> ${onPage.split("::")[1]}`,
    ]));
    // the store's own action still runs it
    expect(all).toContain(`web/src/stores/filters.ts::reset --page--> ${onPage.split("::")[1]}`);
    // another member of the store, and another store's `page`, run nothing
    expect(all.join("\n")).not.toContain("::leagueOnly");
    expect(all.join("\n")).not.toContain("::elsewhere");
  });
});
