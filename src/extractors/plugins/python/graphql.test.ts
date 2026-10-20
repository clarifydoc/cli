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
class Book:
    title: str
    @strawberry.field
    def author(self) -> str: return "x"

@strawberry.type
class Query:
    books: list[Book] = strawberry.field(resolver=get_books)
    @strawberry.field(name="topBook", permission_classes=[IsAuthenticated])
    def top_book(self, info: strawberry.Info, min_rating: int = 0) -> Book:
        return repo.top(min_rating)

@strawberry.type
class RootMutation:
    @strawberry.mutation
    def add_book(self, title: str) -> Book:
        return repo.add(title)

schema = strawberry.Schema(query=Query, mutation=RootMutation)`);
    expect(rows(routes)).toEqual(["/graphql/books → get_books", "/graphql/topBook → Query.top_book (minRating: int)", "/graphql/addBook → RootMutation.add_book (title: str)"]);
    expect(routes[1]!.middleware).toEqual(["IsAuthenticated"]);
    expect(routes[1]!.calls.map((c) => c.name)).toContain("repo.top");
  });

  it("reads Graphene root types: fields with their resolve_ methods, arguments, mutations", async () => {
    const routes = await routesOf(`
import graphene

class Query(graphene.ObjectType):
    all_users = graphene.List(UserType, first=graphene.Int())
    hello = graphene.String(name="greeting")
    def resolve_all_users(root, info, first=None):
        return User.objects.all()

class Mutation(graphene.ObjectType):
    create_user = CreateUser.Field()

class UserType(graphene.ObjectType):
    full_name = graphene.String()`);
    expect(rows(routes)).toEqual(["/graphql/allUsers → Query.resolve_all_users (first: Int)", "/graphql/greeting", "/graphql/createUser → CreateUser.mutate"]);
  });
});
