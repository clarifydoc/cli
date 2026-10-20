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
    const a = await fileOf("src/server/post.ts", `import { createTRPCRouter, publicProcedure, protectedProcedure } from "./trpc";
export const postRouter = createTRPCRouter({
  latest: publicProcedure.query(() => db.post.findFirst()),
  create: protectedProcedure.input(schema).mutation(async ({ input }) => db.post.create({ data: input })),
  admin: { purge: protectedProcedure.mutation(() => db.post.deleteMany()) },
  tags: t.router({ list: publicProcedure.query(() => listTags()) }),
  comments: commentRouter,
  "with-dash": publicProcedure.query(() => 1),
});`);
    expect(rows(a)).toEqual([
      "GET /trpc/latest postRouter calls=db.post.findFirst",
      "POST /trpc/create postRouter [protectedProcedure] calls=db.post.create",
      "POST /trpc/admin.purge postRouter [protectedProcedure] calls=db.post.deleteMany",
      "GET /trpc/tags.list postRouter calls=listTags",
      "GET /trpc/with-dash postRouter calls=",
    ]);
    expect(a.routeFacts!.filter((f) => f.kind === "trpc-mount").map((f) => f.data)).toEqual([{ key: "comments", router: "commentRouter" }]);
  });

  it("reads a tRPC 11 router record, and no object without a procedure", async () => {
    const a = await fileOf("src/post.ts", `import type { TRPCRouterRecord } from "@trpc/server";
export const postRouter = {
  all: publicProcedure.query(({ ctx }) => ctx.db.query.Post.findMany()),
  delete: protectedProcedure.input(z.string()).mutation(({ ctx, input }) => ctx.db.delete(Post)),
} satisfies TRPCRouterRecord;
export const config = { all: 1, nested: { x: 2 } };`);
    expect(rows(a)).toEqual([
      "GET /trpc/all postRouter calls=ctx.db.query.Post.findMany",
      "POST /trpc/delete postRouter [protectedProcedure] calls=ctx.db.delete,Post",
    ]);
  });

  it("an inline object input is the procedure's body, named after it; a scalar input is none", async () => {
    const a = await fileOf("src/post.ts", `export const postRouter = createTRPCRouter({
  byId: publicProcedure.input(z.object({ id: z.string() })).query(() => 1),
  remove: publicProcedure.input(z.string()).mutation(() => 1),
});`);
    expect(a.routes.map((r) => `${r.path} ${(r.params ?? []).map((p) => p.type).join(",") || "-"}`)).toEqual([
      "/trpc/byId postRouter.byId.input",
      "/trpc/remove -",
    ]);
  });

  it("leaves an Express router and a file that builds no procedure alone", async () => {
    const a = await fileOf("src/x.ts", `const router = express.Router(); const r = router({ strict: true }); const cfg = createRouter({ routes });`);
    expect(a.routes).toEqual([]);
  });

  it("serves a mounted router under every key path a root reaches it by", async () => {
    const root = await fileOf("src/root.ts", `import { postRouter } from "./post";
export const appRouter = createTRPCRouter({ health: publicProcedure.query(() => "ok"), post: postRouter, blog: { posts: postRouter } });`);
    const post = await fileOf("src/post.ts", `export const postRouter = createTRPCRouter({ byId: publicProcedure.query(() => 1) });`);
    const ctx = {
      importIndex: { localFor: (f: string, n: string) => (f === "src/root.ts" && n === "postRouter" ? "src/post.ts" : null), sourceFor: () => null, namespacesFor: () => [] },
    } as unknown as ProjectContext;
    trpcRouterResolver.resolve([root, post], ctx);
    expect(root.routes.map((r) => r.path)).toEqual(["/trpc/health"]);
    expect(post.routes.map((r) => r.path)).toEqual(["/trpc/post.byId", "/trpc/blog.posts.byId"]);
  });
});
