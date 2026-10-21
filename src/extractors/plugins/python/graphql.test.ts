import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { pythonRouteExtractor } from "./routes.js";
import type { RouteInfo } from "../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "python" as any, "schema.py");
  return pythonRouteExtractor.extractRoutes(tree, src, "schema.py").filter((r) => r.path.startsWith("/graphql/"));
}
const rows = (rs: RouteInfo[]) => rs.map((r) => `${r.path}${r.handler ? ` → ${r.handler}` : ""}${r.params?.length ? ` (${r.params.map((p) => `${p.name}: ${p.type}`).join(", ")})` : ""}`);

describe("Python code-first GraphQL", () => {
  it("reads Strawberry root types: resolver methods, resolver fields, names, arguments, permissions", async () => {
    const routes = await routesOf(`
import strawberry
from .permissions import IsAuthenticated

@strawberry.type
class Stadium:
    title: str
    @strawberry.field
    def scout(self) -> str: return "x"

@strawberry.type
class Query:
    stadiums: list[Stadium] = strawberry.field(resolver=get_stadiums)
    @strawberry.field(name="topStadium", permission_classes=[IsAuthenticated])
    def top_stadium(self, info: strawberry.Info, min_rating: int = 0) -> Stadium:
        return repo.top(min_rating)

@strawberry.type
class RootMutation:
    @strawberry.mutation
    def add_stadium(self, title: str) -> Stadium:
        return repo.add(title)

schema = strawberry.Schema(query=Query, mutation=RootMutation)`);
    expect(rows(routes)).toEqual(["/graphql/stadiums → get_stadiums", "/graphql/topStadium → Query.top_stadium (minRating: int)", "/graphql/addStadium → RootMutation.add_stadium (title: str)"]);
    expect(routes[1]!.middleware).toEqual(["IsAuthenticated"]);
    expect(routes[1]!.calls.map((c) => c.name)).toContain("repo.top");
  });

  it("reads Graphene root types: fields with their resolve_ methods, arguments, mutations", async () => {
    const routes = await routesOf(`
import graphene

class Query(graphene.ObjectType):
    all_players = graphene.List(PlayerType, first=graphene.Int())
    hello = graphene.String(name="greeting")
    def resolve_all_players(root, info, first=None):
        return Player.objects.all()

class Mutation(graphene.ObjectType):
    create_player = CreatePlayer.Field()

class PlayerType(graphene.ObjectType):
    full_name = graphene.String()`);
    expect(rows(routes)).toEqual(["/graphql/allPlayers → Query.resolve_all_players (first: Int)", "/graphql/greeting", "/graphql/createPlayer → CreatePlayer.mutate"]);
  });
});
