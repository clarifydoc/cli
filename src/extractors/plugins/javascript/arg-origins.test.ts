import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

async function originsOf(src: string, fnName: string, call: string) {
  const tree = await parseSource(src, "typescript" as never, "x.tsx");
  const x = new JavaScriptExtractor();
  const fns = [...x.extractFunctions(tree, src), ...x.extractClasses(tree, src).flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
  return fns.find((f) => f.name === fnName)?.calls.find((c) => c.name === call)?.argOrigins;
}

describe("argument origins (JS/TS)", () => {
  it("reads a route parameter, a query value, a parameter and a literal beside them", async () => {
    const src = `import { useParams, useSearchParams } from "react-router-dom";
export function ClubPage() {
  const { clubId } = useParams();
  const [search] = useSearchParams();
  loadClub(Number(clubId), search.get("season"), "squad");
}
export function loadSquad(clubId: string) {
  return api.getSquad(clubId, 25);
}`;
    expect(await originsOf(src, "ClubPage", "loadClub")).toEqual([
      { index: 0, origin: { kind: "route-param", name: "clubId" }, transform: "Number" },
      { index: 1, origin: { kind: "query-param", name: "season" } },
      { index: 2, origin: { kind: "literal", value: "squad" } },
    ]);
    expect(await originsOf(src, "loadSquad", "api.getSquad")).toEqual([
      { index: 0, origin: { kind: "param", name: "clubId", index: 0 } },
      { index: 1, origin: { kind: "literal", value: "25" } },
    ]);
  });

  it("reads React Router's match params, Vue's route and a computed wrapper (real-repo FP)", async () => {
    const src = `class Profile extends React.Component {
  componentWillMount() {
    this.props.onLoad(agent.Profile.get(this.props.match.params.username));
  }
}
export function useMatch() {
  const route = useRoute();
  const matchId = computed(() => Number(route.params.matchId));
  fetchMatch(matchId.value);
  fetchTable(route.query.season);
}`;
    expect(await originsOf(src, "Profile.componentWillMount", "agent.Profile.get")).toEqual([{ index: 0, origin: { kind: "route-param", name: "username" } }]);
    expect(await originsOf(src, "useMatch", "fetchMatch")).toEqual([{ index: 0, origin: { kind: "route-param", name: "matchId" } }]);
    expect(await originsOf(src, "useMatch", "fetchTable")).toEqual([{ index: 0, origin: { kind: "query-param", name: "season" } }]);
  });

  it("reads the properties of an object argument a generated SDK takes its URL values from", async () => {
    const src = `import { useRoute } from "vue-router";
export function clubQuery(id: number) {
  return getClub({ path: { id }, query: { season: "2024" } });
}
export function ClubView() {
  const route = useRoute();
  return getFixture({ path: { club: route.params.clubId, fixture: 7 } });
}`;
    expect(await originsOf(src, "clubQuery", "getClub")).toEqual([
      { index: 0, origin: { kind: "param", name: "id", index: 0 }, field: "path.id" },
      { index: 0, origin: { kind: "literal", value: "2024" }, field: "query.season" },
    ]);
    expect(await originsOf(src, "ClubView", "getFixture")).toEqual([
      { index: 0, origin: { kind: "route-param", name: "clubId" }, field: "path.club" },
      { index: 0, origin: { kind: "literal", value: "7" }, field: "path.fixture" },
    ]);
  });

  it("reports nothing for a call whose arguments say nothing (literals alone, locals)", async () => {
    const src = `export function Garage() {
  const car = pick();
  track("opened");
  park(car);
}`;
    expect(await originsOf(src, "Garage", "track")).toBeUndefined();
    expect(await originsOf(src, "Garage", "park")).toBeUndefined();
  });
});
