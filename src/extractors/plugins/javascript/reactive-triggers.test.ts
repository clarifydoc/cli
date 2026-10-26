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
