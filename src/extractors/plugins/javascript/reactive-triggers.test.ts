import { describe, it, expect } from "vitest";
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";
import { addReactiveTriggers } from "./reactive-triggers.js";

const SFC = `<template><Search @search="findPlayer" /></template>
<script lang="ts" setup>
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { usePlayerSearch } from '@/composables/usePlayerSearch'
import { clubSearchQuery } from '@/client/queries/clubs'

const playerSearch = ref('')
const { users } = usePlayerSearch(playerSearch)
const clubSearch = ref('')
const { data } = useQuery(computed(() => ({
\t...clubSearchQuery(clubSearch.value),
})))

function findPlayer(query: string) {
\tplayerSearch.value = query
}
function findClub(query: string) { clubSearch.value = query }
function same(query: string) { return playerSearch.value === query }
</script>
`;

function analysis(): FileAnalysis {
  const fn = (name: string, line: number, endLine: number) => ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine });
  return {
    ...createEmptyAnalysis("src/views/Squad.vue", "typescript"),
    imports: [
      { source: "vue", specifiers: ["computed", "ref"], isDefault: false, isNamespace: false, isType: false, line: 3 },
      { source: "@tanstack/vue-query", specifiers: ["useQuery"], isDefault: false, isNamespace: false, isType: false, line: 4 },
      { source: "src/composables/usePlayerSearch", specifiers: ["usePlayerSearch"], isDefault: false, isNamespace: false, isType: false, line: 5 },
      { source: "src/client/queries/clubs", specifiers: ["clubSearchQuery"], isDefault: false, isNamespace: false, isType: false, line: 6 },
    ],
    functions: [fn("findPlayer", 15, 17), fn("findClub", 18, 18), fn("same", 19, 19)],
  };
}

describe("a handler that only writes a ref", () => {
  it("triggers the composable, or the query factory, built from that ref at setup (real-repo FP)", () => {
    const a = analysis();
    addReactiveTriggers(a, SFC);
    expect(a.functions.map((f) => `${f.name}: ${f.calls.map((c) => `${c.name} ${c.kind} ${c.target} @${c.line}`).join(", ")}`)).toEqual([
      "findPlayer: usePlayerSearch cross-file src/composables/usePlayerSearch @16",
      "findClub: clubSearchQuery cross-file src/client/queries/clubs @18",
      "same: ",
    ]);
  });
});

const GATED = `<template>
  <TeamList @page="currentPage = $event" />
  <button @click="createOpen = true">open</button>
  <button @click="createOpen = false">close</button>
</template>
<script lang="ts" setup>
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { clubSearchQuery } from '@/client/queries/clubs'
import { squadQuery } from '@/client/queries/squad'

const currentPage = ref(1)
const squad = useQuery(computed(() => squadQuery(currentPage.value)))
const createOpen = ref(false)
const clubSearch = ref('')
const { data } = useQuery(computed(() => ({
	...clubSearchQuery(clubSearch.value),
	enabled: createOpen.value,
})))

function openCreate() {
	createOpen.value = true
	clubSearch.value = ''
}
function closeCreate() {
	createOpen.value = false
}
</script>
`;

function gatedAnalysis(): FileAnalysis {
  const fn = (name: string, line: number, endLine: number) => ({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine });
  const lineOf = (needle: string) => GATED.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const imp = (source: string, name: string) => ({ source, specifiers: [name], isDefault: false, isNamespace: false, isType: false, line: 1 });
  const el = (event: string, handler: string, line: number, extra: object = {}) => ({ element: "button" as const, event, handler, line, ...extra });
  return {
    ...createEmptyAnalysis("src/views/Clubs.vue", "typescript"),
    imports: [imp("@tanstack/vue-query", "useQuery"), imp("src/client/queries/clubs", "clubSearchQuery"), imp("src/client/queries/squad", "squadQuery")],
    functions: [fn("openCreate", lineOf("function openCreate"), lineOf("function openCreate") + 3), fn("closeCreate", lineOf("function closeCreate"), lineOf("function closeCreate") + 2)],
    interactiveElements: [
      el("@page", "currentPage = $event", 2, { element: "custom", component: "TeamList" }),
      el("@click", "createOpen = true", 3),
      el("@click", "createOpen = false", 4),
    ],
  };
}

describe("a write that can only switch a query's enabled flag off", () => {
  it("triggers nothing; one that can turn it on, or change a key, does (real-repo FP)", () => {
    const a = gatedAnalysis();
    addReactiveTriggers(a, GATED);
    const callsOf = (name: string) => a.functions.find((f) => f.name === name)!.calls.map((c) => c.name);
    expect(callsOf("openCreate")).toEqual(["clubSearchQuery"]);
    expect(callsOf("closeCreate")).toEqual([]);
  });

  it("an inline template write is the same trigger, held by the element and the component's setup", () => {
    const a = gatedAnalysis();
    addReactiveTriggers(a, GATED);
    expect(a.interactiveElements.map((e) => e.calls ?? [])).toEqual([["squadQuery"], ["clubSearchQuery"], []]);
    const setup = a.functions.find((f) => f.name === "<setup>")!;
    expect(setup.calls.map((c) => `${c.name}@${c.line} ${c.target}`)).toEqual(["squadQuery@2 src/client/queries/squad", "clubSearchQuery@3 src/client/queries/clubs"]);
    // A child's event bound to the write alone is a function of its own, which the child's emit reaches.
    expect(a.functions.find((f) => f.name === "<TeamList@page@2>")!.calls.map((c) => c.name)).toEqual(["squadQuery"]);
  });
});
