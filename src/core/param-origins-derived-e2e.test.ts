import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamOrigin } from "../types/analysis.js";

/**
 * A screen value that reaches an API call derived rather than as it is: a
 * record a Pinia store keys by the prop, a project helper's result for the
 * prop, and a getter handed to a composable that reads it with `toValue`.
 * Each keeps the route parameter the router hands the prop as its origin,
 * the steps named; a store field no value keys stays unknown.
 */
describe("paramOrigins through stores and helpers, end to end", () => {
  let dir: string;
  let rows: ParamOrigin[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-derived-"));
    const root = join(dir, "repo");
    for (const d of ["src/views", "src/api", "src/stores", "src/helpers", "src/composables", "server"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", "vue-router": "4.2.0", pinia: "2.1.0", axios: "1.6.0", express: "4.18.0" } }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await writeFile(join(root, "src/api/clubs.ts"), [
      "import axios from 'axios'",
      "export function deleteClub(id: number) {",
      "\treturn axios.delete(`/api/clubs/${id}`)",
      "}",
      "export function getSeason(seasonId: number) {",
      "\treturn axios.get(`/api/seasons/${seasonId}`)",
      "}",
      "export function getMatch(matchId: number) {",
      "\treturn axios.get(`/api/matches/${matchId}`)",
      "}",
      "export function getSquad(squadId: number) {",
      "\treturn axios.get(`/api/squads/${squadId}`)",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/helpers/seasons.ts"), "export function getSeasonIdFromClubId(clubId: number): number {\n\treturn clubId < 0 ? -clubId - 1 : 0\n}\n");
    await writeFile(join(root, "src/stores/clubs.ts"), "import {defineStore} from 'pinia'\nexport const useClubStore = defineStore('club', {\n\tstate: () => ({clubs: {} as Record<number, {id: number}>, currentMatch: null as {id: number} | null}),\n})\n");
    await writeFile(join(root, "src/composables/useSquad.ts"), [
      "import {toValue, type MaybeRefOrGetter} from 'vue'",
      "import {getSquad} from '@/api/clubs'",
      "export function useSquad(clubId: MaybeRefOrGetter<number>) {",
      "\treturn getSquad(toValue(clubId))",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src/views/ClubView.vue"), [
      "<template>",
      "\t<button @click=\"remove\">Remove</button>",
      "\t<button @click=\"loadSeason\">Season</button>",
      "\t<button @click=\"loadMatch\">Match</button>",
      "</template>",
      "",
      "<script setup lang=\"ts\">",
      "import {computed} from 'vue'",
      "import {useClubStore} from '@/stores/clubs'",
      "import {deleteClub, getSeason, getMatch} from '@/api/clubs'",
      "import {getSeasonIdFromClubId} from '@/helpers/seasons'",
      "import {useSquad} from '@/composables/useSquad'",
      "",
      "const props = defineProps<{",
      "\tclubId: number,",
      "}>()",
      "",
      "const clubStore = useClubStore()",
      "const club = computed(() => clubStore.clubs[props.clubId])",
      "const seasonId = computed(() => getSeasonIdFromClubId(props.clubId))",
      "const match = computed(() => clubStore.currentMatch)",
      "const squad = useSquad(() => props.clubId)",
      "",
      "async function remove() {",
      "\tawait deleteClub(club.value.id)",
      "}",
      "async function loadSeason() {",
      "\tawait getSeason(seasonId.value)",
      "}",
      "async function loadMatch() {",
      "\tawait getMatch(match.value.id)",
      "}",
      "</script>",
    ].join("\n"));
    await writeFile(join(root, "src/router.ts"), [
      "import {createRouter, createWebHistory} from 'vue-router'",
      "import ClubView from './views/ClubView.vue'",
      "export default createRouter({",
      "\thistory: createWebHistory(),",
      "\troutes: [",
      "\t\t{path: '/clubs/:clubId', name: 'club', component: ClubView, props: route => ({clubId: Number(route.params.clubId)})},",
      "\t],",
      "})",
    ].join("\n"));
    await writeFile(join(root, "server/app.js"), [
      "const express = require('express')",
      "const app = express()",
      "app.delete('/api/clubs/:id', (req, res) => res.json({id: req.params.id}))",
      "app.get('/api/seasons/:id', (req, res) => res.json({id: req.params.id}))",
      "app.get('/api/matches/:id', (req, res) => res.json({id: req.params.id}))",
      "app.get('/api/squads/:id', (req, res) => res.json({id: req.params.id}))",
      "module.exports = app",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    rows = ((await loadReportSummary(join(dir, "out"))) as { paramOrigins?: ParamOrigin[] }).paramOrigins ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const row = (url: string) => rows.find((r) => r.sink.url === url);

  it("traces a store record's field read off the store by the prop to the route parameter, naming the store", () => {
    const r = row("/api/clubs/${id}")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId", screen: "ClubView", routePath: "/clubs/:clubId" });
    expect(r.derivation).toEqual([expect.objectContaining({ kind: "lookup", object: "clubStore.clubs", field: "id", file: "src/views/ClubView.vue", target: { file: "src/stores/clubs.ts", symbol: "useClubStore" } })]);
    expect(r.confidence).toBe("INFERRED");
  });

  it("traces a project helper's result for the prop to the route parameter, naming the helper", () => {
    const r = row("/api/seasons/${seasonId}")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(r.derivation).toEqual([expect.objectContaining({ kind: "helper", name: "getSeasonIdFromClubId", target: { file: "src/helpers/seasons.ts", symbol: "getSeasonIdFromClubId" } })]);
  });

  it("follows a getter a script-setup call hands a composable", () => {
    const r = row("/api/squads/${squadId}")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(r.derivation).toBeUndefined();
    expect(r.hops.map((h) => h.symbol)).toEqual(["route:/clubs/:clubId", "<setup>", "useSquad"]);
  });

  it("leaves a store field no value keys unknown", () => {
    expect(row("/api/matches/${matchId}")?.origin.kind).toBe("unknown");
  });
});
