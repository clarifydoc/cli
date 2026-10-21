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
@Resolver(() => Player)
export class PlayerResolver {
  constructor(private readonly players: PlayersService) {}
  @Query(() => [Player], { name: "players" })
  all(@Args("first") first: number) { return this.players.list(first); }
  @Mutation(() => Player)
  @UseGuards(GqlAuthGuard)
  createPlayer(@Args("input") input: NewPlayerInput) { return this.players.create(input); }
  @ResolveField()
  games(@Parent() player: Player) { return []; }
  helper() {}
}`);
    expect(rows(routes)).toEqual(["/graphql/players → PlayerResolver.all (first: number)", "/graphql/createPlayer → PlayerResolver.createPlayer (input: NewPlayerInput)"]);
    expect(routes[1]!.middleware).toEqual(["UseGuards(GqlAuthGuard)"]);
  });

  it("reads Pothos root fields in all three spellings, with their resolvers' calls", async () => {
    const routes = await routesOf(`
import SchemaBuilder from "@pothos/core";
const builder = new SchemaBuilder({});
builder.queryType({ fields: (t) => ({ hello: t.string({ resolve: () => greet() }) }) });
builder.queryField("me", (t) => t.field({ type: Player, resolve: (_, __, ctx) => players.load(ctx.id) }));
builder.mutationFields((t) => ({ signUp: t.field({ type: Player, resolve: () => auth.signUp() }) }));
builder.objectType(Player, { fields: (t) => ({ name: t.exposeString("name") }) });`);
    expect(rows(routes)).toEqual(["/graphql/hello", "/graphql/me", "/graphql/signUp"]);
    expect(routes[1]!.calls.map((c) => c.name)).toContain("players.load");
  });

  it("reads Nexus root types, extensions and fields, and graphql-js root object types", async () => {
    const nexus = await routesOf(`
import { queryType, extendType, mutationField, objectType } from "nexus";
export const Query = queryType({ definition(t) { t.list.field("games", { type: "Game", resolve: () => db.game.findMany() }); t.string("ping"); } });
export const More = extendType({ type: "Query", definition(t) { t.nonNull.field("me", { type: "Player" }); } });
export const Ignored = extendType({ type: "Player", definition(t) { t.field("friends", { type: "Player" }); } });
export const Publish = mutationField("publish", { type: "Game", resolve: () => db.game.update() });
export const Player = objectType({ name: "Player", definition(t) { t.string("name"); } });`);
    expect(rows(nexus)).toEqual(["/graphql/games", "/graphql/ping", "/graphql/me", "/graphql/publish"]);
    const js = await routesOf(`
import { GraphQLObjectType, GraphQLString } from "graphql";
const Query = new GraphQLObjectType({ name: "Query", fields: () => ({ stadium: { type: Stadium, resolve: (_, a) => stadiums.get(a.id) } }) });
const Stadium = new GraphQLObjectType({ name: "Stadium", fields: { title: { type: GraphQLString } } });`);
    expect(rows(js)).toEqual(["/graphql/stadium"]);
  });

  it("leaves an HTTP controller's @Query() parameter and a file importing none of these alone", async () => {
    expect(await routesOf(`
import { Controller, Get, Query } from "@nestjs/common";
@Controller("players") export class C { @Get() list(@Query("q") q: string) { return q; } }`)).toEqual([]);
    expect(await routesOf(`builder.queryField("x", (t) => t.field({})); queryType({ definition(t) { t.field("y", {}); } });`)).toEqual([]);
  });
});
