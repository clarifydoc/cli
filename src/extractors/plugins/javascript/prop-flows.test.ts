import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A prop's value through the parent that binds it, and a value typed by the key it travels under. Invented names; labels
 * written by hand from the sources below. Every case has a namesake decoy: another component binding the same prop name to
 * something else, a same-named member on another factory, the same key name exported by another module.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0" } }),
  "src/composables/useApis.ts": `export function useClubApi() {
  async function load() { return fetch("/api/clubs").then((r) => r.json()); }
  return { load };
}
export function usePlayerApi() {
  async function load() { return fetch("/api/players").then((r) => r.json()); }
  return { load };
}
export function useLeague() {
  async function relegate() { return fetch("/api/clubs/relegate", { method: "POST" }); }
  return { relegate };
}
export function useGarage() {
  async function relegate() { return fetch("/api/garage/relegate", { method: "POST" }); }
  return { relegate };
}
export function useSquad() {
  async function release() { return fetch("/api/squad/release", { method: "POST" }); }
  return { release };
}
`,
  "src/keys.ts": `export const LeagueKey = Symbol("league");
export const SharedKey = Symbol("shared");
`,
  "src/garage/keys.ts": `export const LeagueKey = Symbol("garage");
`,
  // The child: a watcher on a prop, and a call through another.
  "src/components/ClubList.vue": `<script setup lang="ts">
import { watch } from "vue";
const props = defineProps<{ query: string; api: any }>();
watch(() => props.query, () => { props.api.load(); });
</script>
<template><div>{{ query }}</div></template>
`,
  "src/pages/ClubPage.vue": `<script setup lang="ts">
import { ref, provide } from "vue";
import ClubList from "../components/ClubList.vue";
import LeagueDesk from "../components/LeagueDesk.vue";
import SquadDesk from "../components/SquadDesk.vue";
import { useClubApi, useLeague, useSquad } from "../composables/useApis";
import { LeagueKey } from "../keys";
const passedQuery = ref("");
const unrelated = ref("");
const clubApi = useClubApi();
provide(LeagueKey, useLeague());
provide("squad", useSquad());
function search(x: string) { passedQuery.value = x; }
function tidy(x: string) { unrelated.value = x; }
</script>
<template>
  <button @click="search('a')">Search</button>
  <button @click="tidy('a')">Tidy</button>
  <ClubList :query="passedQuery" :api="clubApi" />
  <LeagueDesk />
  <SquadDesk />
</template>
`,
  "src/components/LeagueDesk.vue": `<script setup lang="ts">
import { inject } from "vue";
import { LeagueKey } from "../keys";
const league = inject(LeagueKey);
function relegateClub() { league.relegate(); }
</script>
<template><button @click="relegateClub()">Relegate</button></template>
`,
  "src/components/SquadDesk.vue": `<script setup lang="ts">
import { inject } from "vue";
const squad = inject("squad");
</script>
<template><button @click="squad.release()">Release</button></template>
`,
  // Decoys: the same prop names bound to something else, and the same key name from another module.
  "src/components/PlayerList.vue": `<script setup lang="ts">
import { watch } from "vue";
const props = defineProps<{ query: string; api: any }>();
watch(() => props.query, () => { props.api.load(); });
</script>
<template><div>{{ query }}</div></template>
`,
  "src/pages/PlayerPage.vue": `<script setup lang="ts">
import { ref } from "vue";
import PlayerList from "../components/PlayerList.vue";
import { usePlayerApi } from "../composables/useApis";
const q = ref("");
const playerApi = usePlayerApi();
function find(x: string) { q.value = x; }
</script>
<template>
  <button @click="find('a')">Find</button>
  <PlayerList :query="q" :api="playerApi" />
</template>
`,
  "src/garage/GaragePage.vue": `<script setup lang="ts">
import { provide } from "vue";
import GarageDesk from "./GarageDesk.vue";
import { useGarage } from "../composables/useApis";
import { LeagueKey } from "./keys";
provide(LeagueKey, useGarage());
</script>
<template><GarageDesk /></template>
`,
  "src/garage/GarageDesk.vue": `<script setup lang="ts">
import { inject } from "vue";
import { LeagueKey } from "./keys";
const garage = inject(LeagueKey)!;
function relegateCar() { garage.relegate(); }
</script>
<template><button @click="relegateCar()">Relegate</button></template>
`,
  // One component bound by two parents to different values: its prop has no type.
  "src/components/PartList.vue": `<script setup lang="ts">
const props = defineProps<{ api: any }>();
function reload() { props.api.load(); }
</script>
<template><button @click="reload()">Reload</button></template>
`,
  "src/pages/PartsOne.vue": `<script setup lang="ts">
import PartList from "../components/PartList.vue";
import { useClubApi } from "../composables/useApis";
const api = useClubApi();
</script>
<template><PartList :api="api" /></template>
`,
  "src/pages/PartsTwo.vue": `<script setup lang="ts">
import PartList from "../components/PartList.vue";
import { usePlayerApi } from "../composables/useApis";
const api = usePlayerApi();
</script>
<template><PartList :api="api" /></template>
`,
  // Two providers of one key with different values: the injected local has no type.
  "src/pages/SharedOne.vue": `<script setup lang="ts">
import { provide } from "vue";
import { useClubApi } from "../composables/useApis";
import { SharedKey } from "../keys";
provide(SharedKey, useClubApi());
</script>
<template><div /></template>
`,
  "src/pages/SharedTwo.vue": `<script setup lang="ts">
import { provide } from "vue";
import { usePlayerApi } from "../composables/useApis";
import { SharedKey } from "../keys";
provide(SharedKey, usePlayerApi());
</script>
<template><div /></template>
`,
  "src/components/SharedDesk.vue": `<script setup lang="ts">
import { inject } from "vue";
import { SharedKey } from "../keys";
const shared = inject(SharedKey);
function refresh() { shared.load(); }
</script>
<template><button @click="refresh()">Refresh</button></template>
`,
};

describe("a prop through the parent's binding, a value typed by its key", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-prop-flows-"));
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

  const from = (file: string, symbol: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === symbol).map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}@${l.targetLine}`);
  const line = (needle: string) => FILES["src/composables/useApis.ts"]!.split("\n").findIndex((l) => l.includes(needle)) + 1;

  it("runs a child's watcher on a prop when the parent writes the ref it binds", () => {
    expect(from("src/pages/ClubPage.vue", "search").some((l) => l.startsWith("passedQuery -> src/components/ClubList.vue::<watch@"))).toBe(true);
    // A ref the parent writes but binds to no prop, and another page's ref bound to another child.
    expect(from("src/pages/ClubPage.vue", "tidy")).toEqual([]);
    expect(from("src/pages/PlayerPage.vue", "find").every((l) => !l.includes("ClubList"))).toBe(true);
    expect(from("src/pages/PlayerPage.vue", "find").some((l) => l.includes("PlayerList.vue::<watch@"))).toBe(true);
  });

  it("keeps a prop watcher reached from the function registering it, as it was before it became a function of its own", () => {
    expect(from("src/components/ClubList.vue", "<setup>").some((l) => l.startsWith("watch -> src/components/ClubList.vue::<watch@"))).toBe(true);
  });

  it("types a prop from the value every parent binds to it", () => {
    const watcher = summary.symbolLinks.find((l) => l.sourceFile === "src/components/ClubList.vue" && l.callName === "props.api.load");
    expect(watcher && `${watcher.targetFile}::${watcher.targetSymbol}@${watcher.targetLine}`).toBe(`src/composables/useApis.ts::load@${line("useClubApi") + 1}`);
    const other = summary.symbolLinks.find((l) => l.sourceFile === "src/components/PlayerList.vue" && l.callName === "props.api.load");
    expect(other && other.targetLine).toBe(line("usePlayerApi") + 1);
  });

  it("leaves a prop untyped when the parents bind different values to it", () => {
    expect(from("src/components/PartList.vue", "reload")).toEqual([]);
  });

  it("types an injected local from what the provider handed the key", () => {
    expect(from("src/components/LeagueDesk.vue", "relegateClub")).toEqual([`league.relegate -> src/composables/useApis.ts::relegate@${line("useLeague") + 1}`]);
    // The same key name from another module is another key.
    expect(from("src/garage/GarageDesk.vue", "relegateCar")).toEqual([`garage.relegate -> src/composables/useApis.ts::relegate@${line("useGarage") + 1}`]);
  });

  it("types a literal key's injected local when only the markup calls it", () => {
    const link = summary.symbolLinks.find((l) => l.sourceFile === "src/components/SquadDesk.vue" && l.callName === "squad.release");
    expect(link?.targetSymbol).toBe("release");
  });

  it("gives no type when two providers hand one key different values", () => {
    expect(from("src/components/SharedDesk.vue", "refresh")).toEqual([]);
  });
});
