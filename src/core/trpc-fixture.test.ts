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
      "GET /trpc/game.byId src/server/api/routers/game.ts",
      "GET /trpc/game.latest src/server/api/routers/game.ts",
      "GET /trpc/health src/server/api/root.ts",
      "GET /trpc/player.admin.list src/server/api/routers/player.ts",
      "POST /trpc/game.create src/server/api/routers/game.ts",
    ]);
    expect(s.routeMap.find((r) => r.path === "/trpc/game.create")?.middleware).toEqual(["protectedProcedure"]);
    expect(s.routeMap.find((r) => r.path === "/trpc/game.create")?.requestSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      required: ["title"],
    });
  });

  it("links each client hook to its procedure, and the screen through it to the table", async () => {
    const s = await loadReportSummary(out);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url} -> ${l.target}`).sort()).toEqual([
      "src/app/Admin.tsx GET /trpc/game.byId -> src/server/api/routers/game.ts",
      "src/app/Admin.tsx GET /trpc/player.admin.list -> src/server/api/routers/player.ts",
      "src/app/LatestGame.tsx GET /trpc/game.latest -> src/server/api/routers/game.ts",
      "src/app/LatestGame.tsx POST /trpc/game.create -> src/server/api/routers/game.ts",
    ]);
    const writes = (s.dataFlows ?? []).filter((p) => p.effect === "db-write").map((p) => `${p.entryKind} ${p.entryLabel} ${p.resource}`);
    expect(writes).toContain("screen LatestGame Game");
    expect(writes).toContain("route POST /trpc/game.create Game");
  });
});
