import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-rtk-query, against the endpoints its README labels by hand. */
const fixture = resolve("test-fixtures/sample-rtk-query");

describe.skipIf(!existsSync(fixture))("sample-rtk-query", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-rtk-"));
    out = join(dir, "sample-rtk-query");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links every hook through its endpoint to the Express route serving it", async () => {
    const s = await loadReportSummary(out);
    const links = (s.apiRouteLinks ?? []).filter((l) => l.source.startsWith("web/src/features/")).map((l) => `${l.source} ${l.method} ${l.url} -> ${l.routePath}`);
    expect(links.sort()).toEqual([
      "web/src/features/PostDetail.tsx DELETE /api/posts/${id} -> /api/posts/:id",
      "web/src/features/PostDetail.tsx GET /posts/${postId}/comments -> /api/posts/:id/comments",
      "web/src/features/Posts.tsx GET /api/posts -> /api/posts",
      "web/src/features/Posts.tsx GET /api/posts -> /api/posts",
      "web/src/features/Posts.tsx GET /api/posts/${id} -> /api/posts/:id",
      "web/src/features/Posts.tsx POST /api/posts -> /api/posts",
    ]);
  });
});
