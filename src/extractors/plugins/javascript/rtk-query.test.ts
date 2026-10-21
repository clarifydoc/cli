import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { resolveRtkHooks } from "./rtk-query.js";
import { createEmptyAnalysis, type DataSourceInfo, type FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

async function callsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

const SLICE = `import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),
  endpoints: (build) => ({
    getGames: build.query({ query: () => "games" }),
    getGame: build.query({ query: (id) => \`/games/\${id}\` }),
    addGame: build.mutation({ query: (body) => ({ url: "games", method: "POST", body }) }),
    deleteGame: build.mutation({ query(id) { return { url: \`games/\${id}\`, method: "delete" }; } }),
    custom: build.query({ queryFn: () => ({ data: 1 }) }),
  }),
});
export const { useGetGamesQuery, useAddGameMutation } = api;`;

describe("RTK Query", () => {
  it("each endpoint is one api-call at the slice's base, tagged with its name", async () => {
    expect((await callsOf(SLICE)).map((d) => `${d.name} ${d.target} ${d.endpoint}`)).toEqual([
      "GET /api/games getGames",
      "GET /api/games/${id} getGame",
      "POST /api/games addGame",
      "DELETE /api/games/${id} deleteGame",
    ]);
  });

  it("a component's generated hooks and initiate() name the endpoint they call", async () => {
    const calls = await callsOf(`import { useGetGamesQuery, useLazyGetGameQuery, useAddGameMutation, api } from "./api";
import { useAppDispatch } from "./hooks";
export function Games() {
  useGetGamesQuery();
  useLazyGetGameQuery();
  useAddGameMutation();
  useAppDispatch();
  useCustomQuery();
  dispatch(api.endpoints.getGames.initiate());
}`);
    expect(calls.map((d) => `${d.name} ${d.target} ${d.endpoint}`)).toEqual([
      "useGetGamesQuery null getGames",
      "useLazyGetGameQuery null getGame",
      "useAddGameMutation null addGame",
      "api null getGames",
    ]);
  });

  it("the project pass gives a hook call its endpoint's method and URL, from the slice it imports", async () => {
    const slice: FileAnalysis = { ...createEmptyAnalysis("src/api.ts", "typescript"), dataSources: await callsOf(SLICE) };
    const calls = [
      { kind: "api-call" as const, name: "useAddGameMutation", target: null, line: 3, calls: [], endpoint: "addGame", filePath: "src/Games.tsx" },
      { kind: "api-call" as const, name: "useNopeQuery", target: null, line: 4, calls: [], endpoint: "nope", filePath: "src/Games.tsx" },
    ];
    const ctx = { importIndex: { localFor: (_f: string, n: string) => (n.startsWith("use") ? "src/api.ts" : null), sourceFor: () => null, namespacesFor: () => [] } } as unknown as ProjectContext;
    expect(resolveRtkHooks(calls, [slice], ctx)).toBe(1);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual(["POST /api/games", "useNopeQuery null"]);
  });

  it("drops a use…Mutation the project declares itself — a TanStack composable, no generated hook", () => {
    const queries: FileAnalysis = {
      ...createEmptyAnalysis("src/TrainingQueries.ts", "typescript"),
      functions: [{ name: "useUpdateTrainingMutation", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 3, endLine: 8 }],
    };
    const calls = [
      { kind: "api-call" as const, name: "useUpdateTrainingMutation", target: null, line: 9, calls: [], endpoint: "updateTraining", filePath: "src/TrainingInfo.vue" },
      { kind: "api-call" as const, name: "get", target: "/api/x", line: 12, calls: [], filePath: "src/TrainingInfo.vue" },
    ];
    const ctx = { importIndex: { localFor: () => "src/TrainingQueries.ts", sourceFor: () => null, namespacesFor: () => [] } } as unknown as ProjectContext;
    expect(resolveRtkHooks(calls, [queries], ctx)).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(["get"]);
  });
  it("a query that keeps its URL in a local or a ternary gives every value it can take", async () => {
    const calls = await callsOf(`import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  endpoints: (build) => ({
    getGarages: build.query({ query: ({ page }) => { let url = \`/garages?page=\${page}\`; if (page > 1) url += "&more=1"; return url; } }),
    getCarPreferences: build.query({ query: ({ carId, isFleet }) => (isFleet ? \`fleets/\${carId}/preferences\` : \`cars/\${carId}/preferences\`) }),
    addMechanic: build.mutation({ query: (body) => { const url = "/mechanics"; return { url, method: "POST", body }; } }),
    getParts: build.query({ query: (suffix) => { if (suffix) return \`parts?\${suffix}\`; return "parts"; } }),
  }),
});`);
    expect(calls.map((d) => `${d.endpoint} ${d.name} ${d.target} ${(d.targetAlternatives ?? []).join(",")}`)).toEqual([
      "getGarages GET /api/garages?page={} ",
      "getCarPreferences GET /api/fleets/${carId}/preferences /api/cars/${carId}/preferences",
      "addMechanic POST /api/mechanics ",
      "getParts GET /api/parts?${suffix} /api/parts",
    ]);
  });

  it("a mutation is sent where the trigger its hook hands back is called", async () => {
    const calls = await callsOf(`import { useDeleteGameMutation, useLazyGetGameQuery } from "./api";
export function GameList() {
  const [deleteGame, { isLoading }] = useDeleteGameMutation();
  const [loadGame] = useLazyGetGameQuery();
  const handleDelete = async (id) => { await deleteGame({ id }).unwrap(); };
  const handleOpen = (id) => loadGame(id);
  return null;
}
function Elsewhere() { deleteGame(); }`);
    expect(calls.map((d) => `${d.line} ${d.name} ${d.endpoint}`)).toEqual([
      "3 useDeleteGameMutation deleteGame",
      "4 useLazyGetGameQuery getGame",
      "5 useDeleteGameMutation deleteGame",
      "6 useLazyGetGameQuery getGame",
    ]);
  });
});
