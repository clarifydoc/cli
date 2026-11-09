import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamOrigin } from "../types/analysis.js";

/**
 * A screen value handed to a composable, read back off the object it returns:
 * `const { club } = useClub(() => props.clubId)` then `club.value.id`. The
 * composable states how its member derives from the parameter — a ref a
 * `watch` of it fills with a fetch, a computed store lookup keyed by it — so
 * the value keeps the route parameter behind the prop as its origin. A member
 * the composable does not key by the parameter stays unknown.
 */
describe("paramOrigins through a composable's returned members, end to end", () => {
  let dir: string;
  let rows: ParamOrigin[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-composable-"));
    const root = join(dir, "repo");
    for (const d of ["src/views", "src/api", "src/stores", "src/composables", "server"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", "vue-router": "4.2.0", pinia: "2.1.0", axios: "1.6.0", "@tanstack/vue-query": "5.0.0", express: "4.18.0" } }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await writeFile(join(root, "src/api/clubs.ts"), [
      "import axios from 'axios'",
      "export async function getClub(id: number) {",
      "\tconst r = await axios.get(`/api/clubs/${id}`)",
      "\treturn r.data",
      "}",
      "export function deleteClub(id: number) {",
      "\treturn axios.delete(`/api/clubs/${id}`)",
      "}",
      "export function archivePlayer(id: number) {",
      "\treturn axios.post(`/api/players/${id}/archive`)",
      "}",
      "export function deleteSeason(id: number) {",
      "\treturn axios.delete(`/api/seasons/${id}`)",
      "}",
      "export function renameClub(id: number, name: string) {",
      "\treturn axios.put(`/api/clubs/${id}/name`, {name})",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/stores/players.ts"), "import {defineStore} from 'pinia'\nexport const usePlayerStore = defineStore('player', {\n\tstate: () => ({players: {} as Record<number, {id: number}>, current: null as {id: number} | null}),\n})\n");
    await writeFile(join(root, "src/composables/useClub.ts"), [
      "import {ref, watch, toValue, type MaybeRefOrGetter} from 'vue'",
      "import {getClub} from '@/api/clubs'",
      "export function useClub(clubId: MaybeRefOrGetter<number>) {",
      "\tconst club = ref()",
      "\tconst loading = ref(false)",
      "\twatch(() => toValue(clubId), async (id) => {",
      "\t\tloading.value = true",
      "\t\tclub.value = await getClub(id)",
      "\t\tloading.value = false",
      "\t}, {immediate: true})",
      "\treturn {club, loading}",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/composables/usePlayer.ts"), [
      "import {computed, toValue, type MaybeRefOrGetter} from 'vue'",
      "import {usePlayerStore} from '@/stores/players'",
      "export function usePlayer(playerId: MaybeRefOrGetter<number>) {",
      "\tconst playerStore = usePlayerStore()",
      "\tconst player = computed(() => playerStore.players[toValue(playerId)])",
      "\treturn {player}",
      "}",
    ].join("\n"));
    // The decoy: its member is the store's current record, whatever the parameter.
    await writeFile(join(root, "src/composables/useSeason.ts"), [
      "import {computed, type MaybeRefOrGetter} from 'vue'",
      "import {usePlayerStore} from '@/stores/players'",
      "export function useSeason(clubId: MaybeRefOrGetter<number>) {",
      "\tconst playerStore = usePlayerStore()",
      "\tconst season = computed(() => playerStore.current)",
      "\treturn {season, clubId}",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/composables/useRenameClub.ts"), [
      "import {useMutation} from '@tanstack/vue-query'",
      "import {renameClub} from '@/api/clubs'",
      "export function useRenameClub() {",
      "\treturn useMutation({mutationFn: (club: {id: number, name: string}) => renameClub(club.id, club.name)})",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/views/ClubView.vue"), [
      "<template>",
      "\t<button @click=\"remove\">Remove</button>",
      "\t<button @click=\"archive\">Archive</button>",
      "\t<button @click=\"dropSeason\">Season</button>",
      "\t<button @click=\"rename\">Rename</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import {deleteClub, archivePlayer, deleteSeason} from '@/api/clubs'",
      "import {useClub} from '@/composables/useClub'",
      "import {usePlayer} from '@/composables/usePlayer'",
      "import {useSeason} from '@/composables/useSeason'",
      "import {useRenameClub} from '@/composables/useRenameClub'",
      "",
      "const props = defineProps<{",
      "\tclubId: number,",
      "\tplayerId: number,",
      "}>()",
      "",
      "const {club} = useClub(() => props.clubId)",
      "const {player} = usePlayer(() => props.playerId)",
      "const {season} = useSeason(() => props.clubId)",
      "const renaming = useRenameClub()",
      "",
      "async function remove() {",
      "\tawait deleteClub(club.value.id)",
      "}",
      "async function archive() {",
      "\tawait archivePlayer(player.value.id)",
      "}",
      "async function dropSeason() {",
      "\tawait deleteSeason(season.value.id)",
      "}",
      "async function rename() {",
      "\tawait renaming.mutateAsync({...club.value, name: 'Rovers'})",
      "}",
      "</script>",
    ].join("\n"));
    await writeFile(join(root, "src/router.ts"), [
      "import {createRouter, createWebHistory} from 'vue-router'",
      "import ClubView from './views/ClubView.vue'",
      "export default createRouter({",
      "\thistory: createWebHistory(),",
      "\troutes: [",
      "\t\t{path: '/clubs/:clubId/players/:playerId', name: 'club', component: ClubView, props: route => ({clubId: Number(route.params.clubId), playerId: Number(route.params.playerId)})},",
      "\t],",
      "})",
    ].join("\n"));
    await writeFile(join(root, "server/app.js"), [
      "const express = require('express')",
      "const app = express()",
      "app.get('/api/clubs/:id', (req, res) => res.json({id: req.params.id}))",
      "app.delete('/api/clubs/:id', (req, res) => res.json({id: req.params.id}))",
      "app.put('/api/clubs/:id/name', (req, res) => res.json({id: req.params.id}))",
      "app.post('/api/players/:id/archive', (req, res) => res.json({id: req.params.id}))",
      "app.delete('/api/seasons/:id', (req, res) => res.json({id: req.params.id}))",
      "module.exports = app",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    rows = ((await loadReportSummary(join(dir, "out"))) as { paramOrigins?: ParamOrigin[] }).paramOrigins ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const row = (url: string, file = "src/api/clubs.ts", from?: string) => rows.find((r) => r.sink.url === url && r.sink.file === file && (!from || r.hops.some((h) => h.symbol === from)));
  const steps = (r: ParamOrigin | undefined) => (r?.derivation ?? []).map((d) => `${d.kind}:${d.kind === "lookup" ? d.object : d.name}${d.kind === "returned" ? `.${d.key}` : ""}${d.field ? `>${d.field}` : ""}@${d.file}`);

  it("traces a member a watch of the parameter fills with a fetch to the route parameter behind the prop", () => {
    const r = row("/api/clubs/${id}", "src/api/clubs.ts", "remove")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId", screen: "ClubView" });
    expect(steps(r)).toEqual(["returned:useClub.club@src/views/ClubView.vue", "helper:getClub>id@src/composables/useClub.ts"]);
    expect(r.confidence).toBe("INFERRED");
  });

  it("traces a member that is a store lookup keyed by the parameter, naming the store", () => {
    const r = row("/api/players/${id}/archive")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "playerId" });
    expect(steps(r)).toEqual(["returned:usePlayer.player@src/views/ClubView.vue", "lookup:playerStore.players>id@src/composables/usePlayer.ts"]);
    expect(r.derivation![1]!.target).toEqual({ file: "src/stores/players.ts", symbol: "usePlayerStore" });
  });

  it("leaves a member the composable does not key by the parameter unknown", () => {
    expect(row("/api/seasons/${id}")?.origin.kind).toBe("unknown");
  });

  it("follows a record spread into a mutation's argument to the property its callback reads", () => {
    const r = row("/api/clubs/${id}/name")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(steps(r)).toEqual(["returned:useClub.club@src/views/ClubView.vue", "helper:getClub>id@src/composables/useClub.ts"]);
  });

  it("reads a watch callback's parameter as the watched value", () => {
    const r = row("/api/clubs/${id}", "src/api/clubs.ts", "useClub")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(r.derivation).toBeUndefined();
  });
});
