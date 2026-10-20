import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "schema.ts");
  return javascriptRouteExtractor.extractRoutes(tree, src, "schema.ts").filter((r) => r.path.startsWith("/graphql/"));
}
const rows = (rs: RouteInfo[]) => rs.map((r) => `${r.path}${r.handler ? ` → ${r.handler}` : ""}${r.params?.length ? ` (${r.params.map((p) => `${p.name}${p.type ? `: ${p.type}` : ""}`).join(", ")})` : ""}`);

describe("code-first GraphQL", () => {
  it("reads NestJS / TypeGraphQL resolver methods, their names, args and guards", async () => {
    const routes = await routesOf(`
import { Resolver, Query, Mutation, Args } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
@Resolver(() => User)
export class UserResolver {
  constructor(private readonly users: UsersService) {}
  @Query(() => [User], { name: "users" })
  all(@Args("first") first: number) { return this.users.list(first); }
  @Mutation(() => User)
  @UseGuards(GqlAuthGuard)
  createUser(@Args("input") input: NewUserInput) { return this.users.create(input); }
  @ResolveField()
  posts(@Parent() user: User) { return []; }
  helper() {}
}`);
    expect(rows(routes)).toEqual(["/graphql/users → UserResolver.all (first: number)", "/graphql/createUser → UserResolver.createUser (input: NewUserInput)"]);
    expect(routes[1]!.middleware).toEqual(["UseGuards(GqlAuthGuard)"]);
  });

  it("reads Pothos root fields in all three spellings, with their resolvers' calls", async () => {
    const routes = await routesOf(`
import SchemaBuilder from "@pothos/core";
const builder = new SchemaBuilder({});
builder.queryType({ fields: (t) => ({ hello: t.string({ resolve: () => greet() }) }) });
builder.queryField("me", (t) => t.field({ type: User, resolve: (_, __, ctx) => users.load(ctx.id) }));
builder.mutationFields((t) => ({ signUp: t.field({ type: User, resolve: () => auth.signUp() }) }));
builder.objectType(User, { fields: (t) => ({ name: t.exposeString("name") }) });`);
    expect(rows(routes)).toEqual(["/graphql/hello", "/graphql/me", "/graphql/signUp"]);
    expect(routes[1]!.calls.map((c) => c.name)).toContain("users.load");
  });

  it("reads Nexus root types, extensions and fields, and graphql-js root object types", async () => {
    const nexus = await routesOf(`
import { queryType, extendType, mutationField, objectType } from "nexus";
export const Query = queryType({ definition(t) { t.list.field("posts", { type: "Post", resolve: () => db.post.findMany() }); t.string("ping"); } });
export const More = extendType({ type: "Query", definition(t) { t.nonNull.field("me", { type: "User" }); } });
export const Ignored = extendType({ type: "User", definition(t) { t.field("friends", { type: "User" }); } });
export const Publish = mutationField("publish", { type: "Post", resolve: () => db.post.update() });
export const User = objectType({ name: "User", definition(t) { t.string("name"); } });`);
    expect(rows(nexus)).toEqual(["/graphql/posts", "/graphql/ping", "/graphql/me", "/graphql/publish"]);
    const js = await routesOf(`
import { GraphQLObjectType, GraphQLString } from "graphql";
const Query = new GraphQLObjectType({ name: "Query", fields: () => ({ book: { type: Book, resolve: (_, a) => books.get(a.id) } }) });
const Book = new GraphQLObjectType({ name: "Book", fields: { title: { type: GraphQLString } } });`);
    expect(rows(js)).toEqual(["/graphql/book"]);
  });

  it("leaves an HTTP controller's @Query() parameter and a file importing none of these alone", async () => {
    expect(await routesOf(`
import { Controller, Get, Query } from "@nestjs/common";
@Controller("users") export class C { @Get() list(@Query("q") q: string) { return q; } }`)).toEqual([]);
    expect(await routesOf(`builder.queryField("x", (t) => t.field({})); queryType({ definition(t) { t.field("y", {}); } });`)).toEqual([]);
  });
});
