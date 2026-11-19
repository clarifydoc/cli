import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamOrigin } from "../types/analysis.js";

async function project(files: Record<string, string>): Promise<{ dir: string; summary: Record<string, any> }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-url-params-"));
  const root = join(dir, "repo");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { dir, summary: (await loadReportSummary(join(dir, "out"))) as Record<string, any> };
}

const VUE_PACKAGE = JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", "vue-router": "4.2.0", axios: "1.6.0", "@tanstack/vue-query": "5.0.0", express: "4.18.0" } });
const ALIAS = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
const ROUTER = [
  "import {createRouter, createWebHistory} from 'vue-router'",
  "import ClubView from './views/ClubView.vue'",
  "export default createRouter({history: createWebHistory(), routes: [",
  "\t{path: '/clubs/:clubId', name: 'club', component: ClubView, props: route => ({clubId: Number(route.params.clubId)})},",
  "]})",
].join("\n");

/**
 * A value read off a TanStack Query result in a composable (`query.data.value`, a normaliser over it, a `computed`
 * with a block body) keeps the screen value the query's options are keyed by.
 */
describe("paramOrigins through a composable's query result, end to end", () => {
  let dir: string;
  let rows: ParamOrigin[];
  beforeAll(async () => {
    const made = await project({
        "package.json": VUE_PACKAGE,
        "tsconfig.json": ALIAS,
        "src/api/clubs.ts": [
          "import axios from 'axios'",
          "export async function getClub(id: number) {",
          "\tconst r = await axios.get(`/api/clubs/${id}`)",
          "\treturn r.data",
          "}",
          "export function deleteClub(id: number) {",
          "\treturn axios.delete(`/api/clubs/${id}`)",
          "}",
          "export function archiveSquad(id: number) {",
          "\treturn axios.post(`/api/squads/${id}/archive`)",
          "}",
          "export function retirePlayer(id: number) {",
          "\treturn axios.post(`/api/players/${id}/retire`)",
          "}",
          "export function listSquads() {",
          "\treturn axios.get(`/api/squads`)",
          "}",
          "export function closeSquad(id: number) {",
          "\treturn axios.post(`/api/squads/${id}/close`)",
          "}",
        ].join("\n"),
        "src/api/queries.ts": [
          "import {getClub, listSquads} from './clubs'",
          "export function clubQuery(id: number) {",
          "\treturn {queryKey: ['club', id], queryFn: () => getClub(id)}",
          "}",
          // Keyed by the id, but the fetch drops it.
          "export function squadsQuery(id: number) {",
          "\treturn {queryKey: ['squads', id], queryFn: () => listSquads()}",
          "}",
          "export function normalizeClub(raw: any) {",
          "\treturn {...raw}",
          "}",
        ].join("\n"),
        "src/composables/useClubQuery.ts": [
          "import {computed, ref, watchEffect, toValue, type MaybeRefOrGetter} from 'vue'",
          "import {useQuery} from '@tanstack/vue-query'",
          "import {clubQuery, normalizeClub} from '@/api/queries'",
          "export function useClubQuery(clubId: MaybeRefOrGetter<number>) {",
          "\tconst query = useQuery(computed(() => clubQuery(toValue(clubId))))",
          "\tconst club = computed(() => query.data.value)",
          "\tconst squad = computed(() => { return query.data.value?.squad })",
          "\tconst player = ref()",
          "\twatchEffect(() => { player.value = normalizeClub(query.data.value) })",
          "\treturn {club, squad, player}",
          "}",
        ].join("\n"),
        // The decoy: a query keyed by a literal, whatever the parameter.
        "src/composables/useOtherQuery.ts": [
          "import {computed, type MaybeRefOrGetter} from 'vue'",
          "import {useQuery} from '@tanstack/vue-query'",
          "import {clubQuery} from '@/api/queries'",
          "export function useOtherQuery(clubId: MaybeRefOrGetter<number>) {",
          "\tconst query = useQuery(computed(() => clubQuery(7)))",
          "\tconst club = computed(() => query.data.value)",
          "\treturn {club, clubId}",
          "}",
        ].join("\n"),
        "src/composables/useSquadsQuery.ts": [
          "import {computed, type MaybeRefOrGetter, toValue} from 'vue'",
          "import {useQuery} from '@tanstack/vue-query'",
          "import {squadsQuery} from '@/api/queries'",
          "export function useSquadsQuery(clubId: MaybeRefOrGetter<number>) {",
          "\tconst query = useQuery(computed(() => squadsQuery(toValue(clubId))))",
          "\tconst squads = computed(() => query.data.value)",
          "\treturn {squads}",
          "}",
        ].join("\n"),
        "src/views/ClubView.vue": [
          "<template>",
          "\t<button @click=\"close\">Close</button>",
          "\t<button @click=\"remove\">Remove</button>",
          "\t<button @click=\"archive\">Archive</button>",
          "\t<button @click=\"retire\">Retire</button>",
          "\t<button @click=\"removeOther\">Other</button>",
          "</template>",
          "<script setup lang=\"ts\">",
          "import {deleteClub, archiveSquad, retirePlayer, closeSquad} from '@/api/clubs'",
          "import {useClubQuery} from '@/composables/useClubQuery'",
          "import {useSquadsQuery} from '@/composables/useSquadsQuery'",
          "import {useOtherQuery} from '@/composables/useOtherQuery'",
          "const props = defineProps<{ clubId: number }>()",
          "const {club, squad, player} = useClubQuery(() => props.clubId)",
          "const {club: other} = useOtherQuery(() => props.clubId)",
          "const {squads} = useSquadsQuery(() => props.clubId)",
          "async function close() { await closeSquad(squads.value.id) }",
          "async function remove() { await deleteClub(club.value.id) }",
          "async function archive() { await archiveSquad(squad.value.id) }",
          "async function retire() { await retirePlayer(player.value.id) }",
          "async function removeOther() { await deleteClub(other.value.id) }",
          "</script>",
        ].join("\n"),
        "src/router.ts": ROUTER,
        "server/app.js": [
          "const express = require('express')",
          "const app = express()",
          "app.get('/api/clubs/:id', (req, res) => res.json({}))",
          "app.delete('/api/clubs/:id', (req, res) => res.json({}))",
          "app.post('/api/squads/:id/archive', (req, res) => res.json({}))",
          "app.post('/api/players/:id/retire', (req, res) => res.json({}))",
          "app.post('/api/squads/:id/close', (req, res) => res.json({}))",
          "module.exports = app",
        ].join("\n"),
    });
    dir = made.dir;
    rows = made.summary.paramOrigins ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const row = (url: string, from: string) => rows.find((r) => r.sink.url === url && r.hops.some((h) => h.symbol === from));
  const steps = (r: ParamOrigin | undefined) => (r?.derivation ?? []).map((d) => `${d.kind}:${d.kind === "lookup" ? d.object : d.name}${d.field ? `>${d.field}` : ""}`);

  it("traces a computed over query.data to the route parameter behind the prop", () => {
    const r = row("/api/clubs/${id}", "remove")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId", screen: "ClubView" });
    expect(steps(r)).toEqual(["returned:useClubQuery", "helper:clubQuery>id"]);
    expect(r.confidence).toBe("INFERRED");
  });

  it("reads a computed with a block body, keeping the property read off the data", () => {
    const r = row("/api/squads/${id}/archive", "archive")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(steps(r)).toEqual(["returned:useClubQuery", "helper:clubQuery>squad.id"]);
  });

  it("follows a normaliser over the query's data", () => {
    const r = row("/api/players/${id}/retire", "retire")!;
    expect(r.origin).toMatchObject({ kind: "route-param", name: "clubId" });
    expect(steps(r)).toEqual(["returned:useClubQuery", "helper:clubQuery", "helper:normalizeClub>id"]);
  });

  it("leaves a query unknown when its fetch drops the id the key holds", () => {
    expect(row("/api/squads/${id}/close", "close")?.origin.kind).toBe("unknown");
  });

  it("leaves a query keyed by a literal unknown", () => {
    expect(row("/api/clubs/${id}", "removeOther")?.origin.kind).toBe("unknown");
  });
});

/**
 * A destructured parameter binds its own name: an outer binding of the same name is not where the value comes
 * from. A call recorded in `<setup>` and again as a hook callback's own record is one origin row.
 */
describe("paramOrigins: a destructured parameter and a call recorded twice, end to end", () => {
  let dir: string;
  let rows: ParamOrigin[];
  beforeAll(async () => {
    const made = await project({
      "package.json": VUE_PACKAGE,
      "tsconfig.json": ALIAS,
      "src/api/clubs.ts": [
        "import axios from 'axios'",
        "export function getClub(id: number) {",
        "\treturn axios.get(`/api/clubs/${id}`)",
        "}",
        "export function getPlayer(id: number) {",
        "\treturn axios.get(`/api/players/${id}`)",
        "}",
        "export function getSeason(id: number) {",
        "\treturn axios.get(`/api/seasons/${id}`)",
        "}",
      ].join("\n"),
      "src/views/ClubView.vue": [
        "<template><div /></template>",
        "<script setup lang=\"ts\">",
        "import {onMounted} from 'vue'",
        "import {useRoute} from 'vue-router'",
        "import {getClub, getPlayer, getSeason} from '@/api/clubs'",
        "const route = useRoute()",
        "const id = route.params.id",
        "function loadClub({ id }: { id: number }) { return getClub(id) }",
        "function loadPlayer(id: number) { return getPlayer(id) }",
        "loadClub({ id: 5 })",
        "onMounted(() => { loadPlayer(id) })",
        "onMounted(() => { getSeason(route.params.id) })",
        "</script>",
      ].join("\n"),
      "src/router.ts": ROUTER.replace("/clubs/:clubId", "/clubs/:id"),
      "server/app.js": [
        "const express = require('express')",
        "const app = express()",
        "app.get('/api/clubs/:id', (req, res) => res.json({}))",
        "app.get('/api/players/:id', (req, res) => res.json({}))",
        "app.get('/api/seasons/:id', (req, res) => res.json({}))",
        "module.exports = app",
      ].join("\n"),
    });
    dir = made.dir;
    rows = made.summary.paramOrigins ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const of = (url: string) => rows.filter((r) => r.sink.url === url);

  it("does not read a destructured parameter as the outer binding of its name", () => {
    expect(of("/api/clubs/${id}").map((r) => r.origin.kind)).toEqual(["unknown"]);
  });

  it("keeps a plain parameter handed the outer binding", () => {
    expect(of("/api/players/${id}").map((r) => r.origin.kind)).toEqual(["route-param"]);
  });

  it("gives a call recorded in <setup> and as a hook callback one origin row", () => {
    expect(of("/api/seasons/${id}")).toHaveLength(1);
    expect(of("/api/seasons/${id}")[0]!.origin.kind).toBe("route-param");
  });
});
