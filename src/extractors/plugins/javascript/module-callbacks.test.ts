import { describe, it, expect } from "vitest";
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";

const topLevel = async (src: string) =>
  extractTopLevelCalls(await parseSource(src, "typescript" as never, "ClubList.ts"), "typescript" as never).map((c) => c.name);

describe("module-level callbacks", () => {
  it("are the module's own calls: a query function, a lifecycle hook and an action inside a computed list (real-repo FP)", async () => {
    const calls = await topLevel(`
const { data } = useQuery({
  queryKey: ["clubs"],
  queryFn: async () => {
    const { data } = await leagueClient.content.clubs.listClubs({ page: 1 });
    return data;
  },
});
onMounted(() => loadFixtures());
const items = computed(() => [
  { label: "Delete", action: async () => { await leagueClient.content.clubs.deleteClub({ name }); } },
]);
`);
    expect(calls).toEqual(expect.arrayContaining(["leagueClient.content.clubs.listClubs", "loadFixtures", "leagueClient.content.clubs.deleteClub"]));
  });

  it("are not a handler registered on a router or a test runner, nor a function bound to a name", async () => {
    const calls = await topLevel(`
app.get("/clubs", async (req, res) => { res.json(await repo.findClubs()); });
router.get("/fixtures", asyncHandler(async (req, res) => { res.json(await repo.findFixtures()); }));
const load = async () => { await fetchFixtures(); };
describe("clubs", () => { it("lists", async () => { await listClubsForTest(); }); });
`);
    expect(calls).not.toContain("repo.findClubs");
    expect(calls).not.toContain("repo.findFixtures");
    expect(calls).not.toContain("fetchFixtures");
    expect(calls).not.toContain("listClubsForTest");
  });
});
