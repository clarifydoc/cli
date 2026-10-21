import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Vue 3 + Pinia frontend whose components reach the API only through store
 * actions (real-repo FP: 0 of 234 store-using components reached an api-call).
 * Labels written by hand from the sources below.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", pinia: "^2.1.0", axios: "^1.6.0", express: "^4.18.0", pg: "^8.11.0" } }),
  "src/stores/club-store.ts": `import { defineStore } from 'pinia'
import axios from 'axios'

export const useClubStore = defineStore('clubStore', {
    state: () => ({
        data: [] as string[],
        url: "/api/league/clubs",
    }),
    getters: {
        getAll: (state) => state.data,
        getById(state) {
            return (id: number) => state.data[id]
        },
    },
    actions: {
        async fetchAll() {
            const response = await axios.get(this.url)
            this.data = response.data
        },
        async delete(id: number) {
            await axios.delete(\`\${this.url}/\${id}\`)
            this._dropFromList(id)
        },
        _dropFromList(id: number) {
            this.data.splice(id, 1)
        },
    },
})
`,
  "src/stores/player-store.ts": `import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export const usePlayerStore = defineStore('players', () => {
    const players = ref([])
    async function load(squad: number) {
        players.value = (await axios.get(\`/api/league/squads/\${squad}/players\`)).data
    }
    const transfer = async (id: number) => axios.post(\`/api/league/players/\${id}/transfer\`)
    return { players, load, transfer }
})
`,
  "src/stores/match-store.ts": `import { defineStore } from 'pinia'
import axios from 'axios'

export const useMatchStore = defineStore('matches', {
    actions: {
        async fetchFixtures(seasonId?: number) {
            const params = [\`active=true\`]
            if (seasonId) params.push(\`seasonId=\${seasonId}\`)
            const url = \`/api/league/matches/fixtures\${params.length ? (\`?\${params.join("&")}\`) : ""}\`
            return axios.get(url)
        },
    },
})
`,
  "src/utils/file-upload.ts": `import axios, { AxiosResponse } from 'axios'

export function resolveFileEndpoint(params: { badgeId?: number; kind?: string; playerId?: number; isKit?: boolean }): string {
    const { badgeId, kind, playerId, isKit = false } = params
    if (badgeId) {
        let endpoint: string
        if (kind === 'home') {
            endpoint = \`/api/league/badges/\${badgeId}/home\`
        } else if (kind === 'away') {
            endpoint = \`/api/league/badges/\${badgeId}/away\`
        } else {
            throw new Error(\`Unknown kind: \${kind}\`)
        }
        return \`\${endpoint}?kit=\${isKit}\`
    }
    if (playerId) {
        return \`/api/league/players/\${playerId}/photo\`
    }
    if (isKit) {
        return '/api/league/kits/upload'
    }
    throw new Error('No matching upload type')
}

export async function uploadFile(file: File, params: { badgeId?: number }): Promise<AxiosResponse> {
    const endpoint = resolveFileEndpoint(params)
    const formData = new FormData()
    formData.append('file', file)
    return axios.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
    })
}
`,
  "src/components/ClubList.vue": `<template>
  <div>
    <button v-for="club in clubs" :key="club" @click="remove(club)">Remove</button>
  </div>
</template>
<script lang="ts">
import { defineComponent } from 'vue'
import { useClubStore } from '@/stores/club-store'

export default defineComponent({
    setup() {
        const clubStore = useClubStore()
        async function remove(id: number) {
            await clubStore.delete(id)
        }
        return { clubs: clubStore.getAll, remove }
    },
})
</script>
`,
  "src/components/SquadView.vue": `<template>
  <button @click="refresh">Refresh</button>
</template>
<script setup lang="ts">
import { usePlayerStore } from '@/stores/player-store'
const playerStore = usePlayerStore()
function refresh() {
    playerStore.load(7)
}
</script>
`,
  "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "server/index.js": `const express = require('express')
const { Pool } = require('pg')
const pool = new Pool()
const app = express()
app.get('/api/league/clubs', async (req, res) => res.json((await pool.query('SELECT * FROM clubs')).rows))
app.delete('/api/league/clubs/:id', async (req, res) => {
    await pool.query('DELETE FROM clubs WHERE id = $1', [req.params.id])
    res.sendStatus(204)
})
app.get('/api/league/squads/:squad/players', (req, res) => res.json([]))
app.post('/api/league/badges/:id/home', (req, res) => res.sendStatus(201))
app.post('/api/league/kits/upload', (req, res) => res.sendStatus(201))
app.get('/api/league/matches/fixtures', (req, res) => res.json([]))
app.listen(3000)
`,
};

describe("Pinia stores — components reach the API through store actions", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-pinia-"));
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

  const call = (file: string, line: number) => summary.apiCalls?.find((c) => c.filePath === file && c.line === line);
  const links = (from: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)").map((l) => `${l.sourceSymbol} -> ${l.targetFile}:${l.targetSymbol}`);

  it("reads an option store's actions as methods of the store, its state as the values `this.url` holds", () => {
    expect(call("src/stores/club-store.ts", 17)?.target).toBe("/api/league/clubs");
    // `${this.url}/${id}`: the state's url, never a bare `/${id}`.
    expect(call("src/stores/club-store.ts", 21)?.target).toBe("/api/league/clubs/${id}");
    expect(links("src/stores/club-store.ts")).toEqual(expect.arrayContaining([
      "ClubStore.delete -> src/stores/club-store.ts:ClubStore._dropFromList",
      "ClubStore.delete -> server/index.js:route:DELETE /api/league/clubs/:id",
    ]));
  });

  it("resolves a component's call on the store a closure holds, and the click reaches the action's request and the table behind it", () => {
    expect(links("src/components/ClubList.vue")).toContain("remove -> src/stores/club-store.ts:ClubStore.delete");
    const reach = summary.symbolReach?.find((r) => r.file === "src/components/ClubList.vue" && r.symbol === "remove");
    const effects = reach?.effects.map((e) => `${e.kind} ${e.originFile}:${e.originSymbol}${e.kind === "api-call" ? "" : ` ${e.resource}`}`);
    expect(effects).toEqual(expect.arrayContaining([
      "api-call src/stores/club-store.ts:ClubStore.delete",
      "db-write server/index.js:route:DELETE /api/league/clubs/:id clubs",
    ]));
    expect(summary.dataFlows?.filter((f) => f.entryFile === "src/components/ClubList.vue").map((f) => `${f.entryKind} ${f.effect} ${f.resource}`)).toContain("screen db-write clubs");
  });

  it("resolves a setup store's returned function through the store", () => {
    expect(links("src/components/SquadView.vue")).toContain("refresh -> src/stores/player-store.ts:PlayerStore.load");
    expect(links("src/stores/player-store.ts")).toContain("PlayerStore.load -> src/stores/player-store.ts:load");
  });

  it("follows a URL helper whose branches assign a local before returning it", () => {
    const upload = call("src/utils/file-upload.ts", 29);
    expect([upload?.target, ...(upload?.targetAlternatives ?? [])]).toEqual([
      "/api/league/badges/${badgeId}/home?kit=${isKit}",
      "/api/league/badges/${badgeId}/away?kit=${isKit}",
      "/api/league/players/${playerId}/photo",
      "/api/league/kits/upload",
    ]);
  });

  it("reads an optional query string written as a ternary as a query, not a path segment", () => {
    expect(call("src/stores/match-store.ts", 10)?.target).toBe("/api/league/matches/fixtures?{}");
  });
});
