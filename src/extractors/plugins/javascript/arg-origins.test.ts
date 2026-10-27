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

  it("reads a TanStack mutationFn's parameter as what its mutate call is handed — plain, destructured or read off (real-repo FP)", async () => {
    const src = `export function deleteClubOptions() {
  return mutationOptions({
    mutationFn: async (id: number) => (await clubsDelete({ path: { id } })).data,
  })
}
export function renameClubOptions() {
  return mutationOptions({
    mutationFn: ({ clubId, name }) => clubsUpdate({ path: { id: clubId }, body: { name } }),
  })
}
export function relegateClubOptions() {
  return mutationOptions({
    mutationFn: async (club: Club) => { await clubsRelegate({ path: { id: club.id } }) },
  })
}
export function ClubView() {
  const { clubId } = useParams();
  rename.mutateAsync({ clubId, name: "Rovers" });
}`;
    expect(await originsOf(src, "deleteClubOptions", "clubsDelete")).toEqual([
      { index: 0, field: "path.id", origin: { kind: "invoked", via: ["mutate", "mutateAsync"], index: 0 } },
    ]);
    expect(await originsOf(src, "renameClubOptions", "clubsUpdate")).toEqual([
      { index: 0, field: "path.id", origin: { kind: "invoked", via: ["mutate", "mutateAsync"], index: 0, field: "clubId" } },
    ]);
    expect(await originsOf(src, "relegateClubOptions", "clubsRelegate")).toEqual([
      { index: 0, field: "path.id", origin: { kind: "invoked", via: ["mutate", "mutateAsync"], index: 0, field: "id" } },
    ]);
    // A mutate call hands every property of its argument to the callback.
    expect(await originsOf(src, "ClubView", "rename.mutateAsync")).toEqual([
      { index: 0, field: "clubId", origin: { kind: "route-param", name: "clubId" } },
      { index: 0, field: "name", origin: { kind: "literal", value: "Rovers" } },
    ]);
  });
});

describe("argument origins — component props (JS/TS)", () => {
  it("reads a Vue prop through defineProps, a destructure, toRefs, toRef and a computed wrapper", async () => {
    const src = `const props = withDefaults(defineProps<{ clubId: number; season?: string }>(), { season: "2026" });
const { playerId } = defineProps<{ playerId: number }>();
const { season } = toRefs(props);
const club = computed(() => props.clubId);
const league = toRef(props, "leagueId");
const page = ref(0);
function load() {
  fetchClub(props.clubId, playerId, season.value, club.value, league.value, page.value);
}`;
    expect(await originsOf(src, "load", "fetchClub")).toEqual([
      { index: 0, origin: { kind: "prop", name: "clubId" } },
      { index: 1, origin: { kind: "prop", name: "playerId" } },
      { index: 2, origin: { kind: "prop", name: "season" } },
      { index: 3, origin: { kind: "prop", name: "clubId" } },
      { index: 4, origin: { kind: "prop", name: "leagueId" } },
    ]);
  });

  it("reads a React component's props, destructured or not, and a class component's this.props", async () => {
    const src = `export function ClubCard({ clubId, name }: Props) {
  useEffect(() => { loadClub(clubId) }, [clubId]);
}
export const PlayerCard = memo((props: Props) => {
  loadPlayer(props.playerId);
});
class SquadPanel extends React.Component {
  componentDidMount() { loadSquad(this.props.clubId, this.props.match.params.season); }
}
function helper({ clubId }) { loadClub(clubId); }`;
    expect(await originsOf(src, "ClubCard", "loadClub")).toEqual([{ index: 0, origin: { kind: "prop", name: "clubId" } }]);
    expect(await originsOf(src, "PlayerCard", "loadPlayer")).toEqual([{ index: 0, origin: { kind: "prop", name: "playerId" } }]);
    expect(await originsOf(src, "SquadPanel.componentDidMount", "loadSquad")).toEqual([
      { index: 0, origin: { kind: "prop", name: "clubId" } },
      { index: 1, origin: { kind: "route-param", name: "season" } },
    ]);
    // A lowercase function's destructured parameter is no component's props.
    expect(await originsOf(src, "helper", "loadClub")).toBeUndefined();
  });
});
