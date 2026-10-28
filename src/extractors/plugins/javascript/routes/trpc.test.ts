import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import { trpcRouterResolver } from "./trpc.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function fileOf(filePath: string, src: string): Promise<FileAnalysis> {
  const tree = await parseSource(src, "typescript" as any, filePath);
  const facts: RouteFact[] = [];
  const routes = javascriptRouteExtractor.extractRoutes(tree, src, filePath, facts);
  return { ...createEmptyAnalysis(filePath, "typescript"), routes, routeFacts: facts };
}

const rows = (a: FileAnalysis) => a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner}${r.middleware.length ? ` [${r.middleware.join(",")}]` : ""} calls=${r.calls.map((c) => c.name).join(",")}`);

describe("tRPC routers", () => {
  it("reads queries, mutations, nested routers and plain objects, with the builder as middleware", async () => {
    const a = await fileOf("src/server/game.ts", `import { createTRPCRouter, publicProcedure, protectedProcedure } from "./trpc";
export const gameRouter = createTRPCRouter({
  latest: publicProcedure.query(() => db.game.findFirst()),
  create: protectedProcedure.input(schema).mutation(async ({ input }) => db.game.create({ data: input })),
  admin: { purge: protectedProcedure.mutation(() => db.game.deleteMany()) },
  tags: t.router({ list: publicProcedure.query(() => listTags()) }),
  comments: commentRouter,
  "with-dash": publicProcedure.query(() => 1),
});`);
    expect(rows(a)).toEqual([
      "GET /trpc/latest gameRouter calls=db.game.findFirst",
      "POST /trpc/create gameRouter [protectedProcedure] calls=db.game.create",
      "POST /trpc/admin.purge gameRouter [protectedProcedure] calls=db.game.deleteMany",
      "GET /trpc/tags.list gameRouter calls=listTags",
      "GET /trpc/with-dash gameRouter calls=",
    ]);
    expect(a.routeFacts!.filter((f) => f.kind === "trpc-mount").map((f) => f.data)).toEqual([{ key: "comments", router: "commentRouter" }]);
  });

  it("reads a tRPC 11 router record, and no object without a procedure", async () => {
    const a = await fileOf("src/game.ts", `import type { TRPCRouterRecord } from "@trpc/server";
export const gameRouter = {
  all: publicProcedure.query(({ ctx }) => ctx.db.query.Game.findMany()),
  delete: protectedProcedure.input(z.string()).mutation(({ ctx, input }) => ctx.db.delete(Game)),
} satisfies TRPCRouterRecord;
export const config = { all: 1, nested: { x: 2 } };`);
    expect(rows(a)).toEqual([
      "GET /trpc/all gameRouter calls=ctx.db.query.Game.findMany",
      "POST /trpc/delete gameRouter [protectedProcedure] calls=ctx.db.delete,Game",
    ]);
  });

  it("an inline object input is the procedure's body, named after it; a scalar input is none", async () => {
    const a = await fileOf("src/game.ts", `export const gameRouter = createTRPCRouter({
  byId: publicProcedure.input(z.object({ id: z.string() })).query(() => 1),
  remove: publicProcedure.input(z.string()).mutation(() => 1),
});`);
    expect(a.routes.map((r) => `${r.path} ${(r.params ?? []).map((p) => p.type).join(",") || "-"}`)).toEqual([
      "/trpc/byId gameRouter.byId.input",
      "/trpc/remove -",
    ]);
  });

  it("leaves an Express router and a file that builds no procedure alone", async () => {
    const a = await fileOf("src/x.ts", `const router = express.Router(); const r = router({ strict: true }); const cfg = createRouter({ routes });`);
    expect(a.routes).toEqual([]);
  });

  it("serves a mounted router under every key path a root reaches it by", async () => {
    const root = await fileOf("src/root.ts", `import { gameRouter } from "./game";
export const appRouter = createTRPCRouter({ health: publicProcedure.query(() => "ok"), game: gameRouter, league: { games: gameRouter } });`);
    const game = await fileOf("src/game.ts", `export const gameRouter = createTRPCRouter({ byId: publicProcedure.query(() => 1) });`);
    const ctx = {
      importIndex: { localFor: (f: string, n: string) => (f === "src/root.ts" && n === "gameRouter" ? "src/game.ts" : null), sourceFor: () => null, namespacesFor: () => [] },
    } as unknown as ProjectContext;
    trpcRouterResolver.resolve([root, game], ctx);
    expect(root.routes.map((r) => r.path)).toEqual(["/trpc/health"]);
    expect(game.routes.map((r) => r.path)).toEqual(["/trpc/game.byId", "/trpc/league.games.byId"]);
  });
});

describe("tRPC procedures built on an instance or handed by reference", () => {
  it("names `t.procedure` by its builder and the referenced function as the handler", async () => {
    const a = await fileOf("src/server/garage.ts", `import { initTRPC } from "@trpc/server";
const t = initTRPC.create();
async function getGarage() { return { id: 1 }; }
export const garageRouter = t.router({
  garage: t.procedure.query(getGarage),
  park: t.protectedProcedure.mutation(garages.park),
  cars: t.procedure.query(() => listCars()),
});`);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler} [${r.middleware.join(",")}]`)).toEqual([
      "GET /trpc/garage getGarage []",
      "POST /trpc/park garages.park [protectedProcedure]",
      "GET /trpc/cars null []",
    ]);
  });
});
