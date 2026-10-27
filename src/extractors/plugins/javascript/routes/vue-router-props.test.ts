import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";

describe("Vue Router props", () => {
  it("records what a route hands its component from the URL", async () => {
    const src = `const routes = [
  { path: '/clubs/:clubId', component: ClubView, props: true },
  { path: '/clubs/:id/squad', component: () => import('../views/SquadView.vue'), props: route => ({ clubId: Number(route.params.id as string), season: route.query.season, mode: 'list' }) },
  { path: '/players/:playerId', component: PlayerView, props: ({ params }) => { return { playerId: params.playerId } } },
  { path: '/table', component: TableView, props: { default: true } },
]`;
    const tree = await parseSource(src, "typescript" as never, "router.ts");
    const routes = javascriptRouteExtractor.extractRoutes(tree, src, "router.ts", []);
    expect(routes.map((r) => [r.path, r.propsFromRoute ?? null])).toEqual([
      ["/clubs/:clubId", true],
      ["/clubs/:id/squad", [{ prop: "clubId", kind: "route-param", name: "id" }, { prop: "season", kind: "query-param", name: "season" }]],
      ["/players/:playerId", [{ prop: "playerId", kind: "route-param", name: "playerId" }]],
      ["/table", null],
    ]);
  });
});
