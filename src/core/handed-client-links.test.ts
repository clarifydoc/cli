import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A store built by a generic factory handed the API client as an argument:
 * the screen calls `clubStore.actions.updateOne(club)`, and only the argument
 * the store was built with (`api.clubs`) says which client's request that is.
 */
const FILES: Record<string, string> = {
  "web/lib/base-client.ts": `export class BaseCrudApi {
  baseRoute = "";
  async getAll() { return fetch(this.baseRoute); }
  async updateOne(id: string, payload: unknown) { return fetch(this.baseRoute + "/" + id, { method: "PUT", body: JSON.stringify(payload) }); }
}
`,
  "web/lib/clubs-api.ts": `import { BaseCrudApi } from "./base-client";
export class ClubsApi extends BaseCrudApi {
  baseRoute = "/api/clubs";
}
`,
  "web/lib/players-api.ts": `import { BaseCrudApi } from "./base-client";
export class PlayersApi extends BaseCrudApi {
  baseRoute = "/api/players";
}
`,
  "web/lib/api-client.ts": `import { ClubsApi } from "./clubs-api";
import { PlayersApi } from "./players-api";
export class LeagueApiClient {
  clubs: ClubsApi = new ClubsApi();
  players: PlayersApi = new PlayersApi();
}
export function useLeagueApi(): LeagueApiClient {
  return new LeagueApiClient();
}
`,
  "web/composables/use-actions-factory.ts": `import type { BaseCrudApi } from "../lib/base-client";
export function useStoreActions(storeKey: string, api: BaseCrudApi) {
  async function refresh() {
    return await api.getAll();
  }
  async function updateOne(club: { id: string }) {
    const data = await api.updateOne(club.id, club);
    await refresh();
    return data;
  }
  return { refresh, updateOne };
}
`,
  "web/composables/use-store-factory.ts": `import { useStoreActions } from "./use-actions-factory";
import type { BaseCrudApi } from "../lib/base-client";
export function useStore(storeKey: string, api: BaseCrudApi) {
  const actions = useStoreActions(storeKey + "-store", api);
  return { actions };
}
`,
  "web/composables/store/use-club-store.ts": `import { useStore } from "../use-store-factory";
import { useLeagueApi } from "../../lib/api-client";
export function useClubStore() {
  const api = useLeagueApi();
  return useStore("club", api.clubs);
}
`,
  "web/composables/store/index.ts": `export * from "./use-club-store";
`,
  "web/pages/clubs.ts": `import { useClubStore } from "../composables/store";
const clubStore = useClubStore();
export async function handleEdit(club: { id: string }) {
  await clubStore.actions.updateOne(club);
}
`,
};

describe("a client handed to the factory that builds a store", () => {
  let root: string;
  let out: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-handed-"));
    out = mkdtempSync(join(tmpdir(), "clarifydoc-handed-out-"));
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("links the screen's call through the factories to the member of the client the store was built with", () => {
    const from = summary.symbolLinks.filter((l) => l.sourceFile === "web/pages/clubs.ts" && l.callName === "clubStore.actions.updateOne");
    // The factory the barrel forwards, not the barrel's line.
    expect(from.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toContain("web/composables/store/use-club-store.ts::useClubStore");
    // The clubs client's update — never the players client's.
    const client = from.filter((l) => /lib\//.test(l.targetFile)).map((l) => l.targetSymbol);
    expect(client.length).toBe(1);
    expect(client[0]).toMatch(/^(?:ClubsApi|BaseCrudApi)\.updateOne$/);
    expect(from.some((l) => /players/.test(l.targetFile))).toBe(false);
  });
});
