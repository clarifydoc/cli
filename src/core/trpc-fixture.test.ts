import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-trpc, against the procedures its README labels by hand. */
const fixture = resolve("test-fixtures/sample-trpc");

describe.skipIf(!existsSync(fixture))("sample-trpc", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-trpc-"));
    out = join(dir, "sample-trpc");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves every procedure at the path the client link requests", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.filePath}`).sort()).toEqual([
      "GET /trpc/health src/server/api/root.ts",
      "GET /trpc/post.byId src/server/api/routers/post.ts",
      "GET /trpc/post.latest src/server/api/routers/post.ts",
      "GET /trpc/user.admin.list src/server/api/routers/user.ts",
      "POST /trpc/post.create src/server/api/routers/post.ts",
    ]);
    expect(s.routeMap.find((r) => r.path === "/trpc/post.create")?.middleware).toEqual(["protectedProcedure"]);
  });

  it("links each client hook to its procedure, and the screen through it to the table", async () => {
    const s = await loadReportSummary(out);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url} -> ${l.target}`).sort()).toEqual([
      "src/app/Admin.tsx GET /trpc/post.byId -> src/server/api/routers/post.ts",
      "src/app/Admin.tsx GET /trpc/user.admin.list -> src/server/api/routers/user.ts",
      "src/app/LatestPost.tsx GET /trpc/post.latest -> src/server/api/routers/post.ts",
      "src/app/LatestPost.tsx POST /trpc/post.create -> src/server/api/routers/post.ts",
    ]);
    const writes = (s.dataFlows ?? []).filter((p) => p.effect === "db-write").map((p) => `${p.entryKind} ${p.entryLabel} ${p.resource}`);
    expect(writes).toContain("screen LatestPost Post");
    expect(writes).toContain("route POST /trpc/post.create Post");
  });
});
