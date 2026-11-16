import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { blankExceptScripts } from "../../../parsers/vue-sfc.js";
import { propBindings, unreadPropBindings } from "./prop-bindings.js";

describe("prop bindings", () => {
  it("reads what JSX hands a child component's props, where the value's origin is known", async () => {
    const src = `export function ClubPage({ season }) {
  const { clubId } = useParams();
  return <div><ClubCard clubId={Number(clubId)} season={season} title="Squad" count={3} onPick={pick} /></div>;
}`;
    const tree = await parseSource(src, "typescript" as never, "ClubPage.tsx");
    expect(propBindings(tree, src, src, "ClubPage.tsx").map((b) => [b.component, b.prop, b.origin, b.transform ?? null])).toEqual([
      ["ClubCard", "clubId", { kind: "route-param", name: "clubId" }, "Number"],
      ["ClubCard", "season", { kind: "prop", name: "season" }, null],
    ]);
  });

  it("lists the bindings whose value no origin is read for, once per tag and prop, never a function or a number", async () => {
    const src = `export function ClubPage({ season }) {
  return <div><ClubCard kind="club" season={season} pick={choose(x)} count={3} onPick={() => go()} /><ClubCard kind="coach" /></div>;
}`;
    const tree = await parseSource(src, "typescript" as never, "ClubPage.tsx");
    propBindings(tree, src, src, "ClubPage.tsx");
    expect(unreadPropBindings(tree).map((u) => `${u.component}.${u.prop}@${u.line}`)).toEqual(["ClubCard.kind@2", "ClubCard.pick@2"]);
    const raw = `<template>
  <div v-for="row in rows"><ClubCard :kind="row.kind" :count="3" :on-pick="() => go()" :season="season" /></div>
</template>
<script setup lang="ts">
const props = defineProps<{ season: string }>();
</script>`;
    const vue = blankExceptScripts(raw);
    const vueTree = await parseSource(vue, "typescript" as never, "ClubView.vue");
    propBindings(vueTree, vue, raw, "ClubView.vue");
    expect(unreadPropBindings(vueTree).map((u) => `${u.component}.${u.prop}@${u.line}`)).toEqual(["ClubCard.kind@2"]);
  });

  it("reads a Vue template's bindings in the scope of its script setup", async () => {
    const raw = `<template>
  <div>
    <ClubHeader :club-id="clubId" :season="season" />
    <player-list v-for="p in players" :player="p" :league-id="$route.params.leagueId" :club="club" />
  </div>
</template>
<script setup lang="ts">
const props = defineProps<{ season: string }>();
const route = useRoute();
const clubId = computed(() => Number(route.params.id));
const club = ref(null);
</script>`;
    const src = blankExceptScripts(raw);
    const tree = await parseSource(src, "typescript" as never, "ClubView.vue");
    expect(propBindings(tree, src, raw, "ClubView.vue").map((b) => [b.component, b.prop, b.origin, b.line])).toEqual([
      ["ClubHeader", "clubId", { kind: "route-param", name: "id" }, 3],
      ["ClubHeader", "season", { kind: "prop", name: "season" }, 3],
      ["player-list", "leagueId", { kind: "route-param", name: "leagueId" }, 4],
    ]);
  });
});
