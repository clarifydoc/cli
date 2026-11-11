import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-convex, against the functions its README labels by hand. */
const fixture = resolve("test-fixtures/sample-convex");

describe.skipIf(!existsSync(fixture))("sample-convex", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-convex-"));
    out = join(dir, "sample-convex");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each function at its module path and each http route at its own", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.filePath}`).sort()).toEqual([
      "GET /convex/admin.leagues.all convex/admin/leagues.ts",
      "GET /convex/clubs.list convex/clubs.ts",
      "POST /convex/clubs.closeSeason convex/clubs.ts",
      "POST /convex/clubs.rename convex/clubs.ts",
      "POST /convex/clubs.retire convex/clubs.ts",
      "POST /convex/clubs.sign convex/clubs.ts",
      "POST /webhooks/transfer convex/http.ts",
    ]);
    expect(s.routeMap.find((r) => r.path === "/convex/clubs.closeSeason")?.internal).toBe(true);
    expect(s.routeMap.find((r) => r.path === "/convex/clubs.list")?.internal).toBeUndefined();
  });

  it("links each client reference to its function, and a screen through it to the table", async () => {
    const s = await loadReportSummary(out);
    const links = (s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url} -> ${l.target}`);
    for (const expected of [
      "src/Clubs.tsx GET /convex/clubs.list -> convex/clubs.ts",
      "src/Clubs.tsx GET /convex/admin.leagues.all -> convex/admin/leagues.ts",
      "src/Clubs.tsx POST /convex/clubs.rename -> convex/clubs.ts",
      "src/Signing.tsx POST /convex/clubs.sign -> convex/clubs.ts",
      "src/Signing.tsx POST /convex/clubs.retire -> convex/clubs.ts",
      "src/prefetch.ts GET /convex/clubs.list -> convex/clubs.ts",
      "convex/clubs.ts POST /convex/clubs.closeSeason -> convex/clubs.ts",
    ]) expect(links).toContain(expected);
    const flows = (s.dataFlows ?? []).map((p) => `${p.entryKind} ${p.entryLabel} ${p.effect} ${p.resource}`);
    expect(flows).toContain("route POST /convex/clubs.sign db-write players");
    expect(flows).toContain("route POST /convex/clubs.rename db-write clubs");
    expect(flows).toContain("route GET /convex/clubs.list db-read clubs");
    expect(flows).toContain("screen Signing db-write players");
  });

  it("reads the schema's tables as entities with their foreign keys", async () => {
    const s = await loadReportSummary(out);
    const graph = s.entityGraph as { nodes: Array<{ name: string }>; edges: Array<{ source: string; target: string }> } | undefined;
    expect(graph?.nodes.map((n) => n.name).sort()).toEqual(["clubs", "leagues", "players"]);
    expect(graph?.edges.map((e) => [e.source, e.target].map((id) => id.split("::").pop()).sort().join("-")).sort()).toEqual(["clubs-leagues", "clubs-players"]);
  });

  it("leaves a namesake query() outside Convex alone", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.some((r) => r.filePath === "lib/query.ts")).toBe(false);
    const tables = (s.dataFlows ?? []).filter((p) => p.entryLabel?.includes("lib/query"));
    expect(tables).toEqual([]);
  });
});
