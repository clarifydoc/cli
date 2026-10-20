import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { diffSurface, renderSurfaceMarkdown } from "./surface-diff.js";

type S = Parameters<typeof diffSurface>[0];
const route = (over: Partial<S["routeMap"][number]> & { path: string }): S["routeMap"][number] => ({
  httpMethod: "POST",
  kind: "api",
  handler: "create",
  calls: [],
  middleware: [],
  line: 10,
  filePath: "api/orders.ts",
  ...over,
});
const kinds = (base: S, head: S) => diffSurface(base, head).changes.map((c) => [c.kind, c.breaking, c.route]);

describe("diffSurface", () => {
  it("lists the import cycles a change creates or grows, not the ones it only touches", () => {
    const base: S = {
      routeMap: [],
      componentGraph: { "a.ts": ["b.ts"], "b.ts": ["a.ts"], "c.ts": ["d.ts"], "x.ts": ["y.ts"], "y.ts": ["x.ts"] },
    };
    const head: S = {
      routeMap: [],
      componentGraph: {
        "a.ts": ["b.ts"], "b.ts": ["a.ts", "e.ts"], "e.ts": ["a.ts"], // grown by e.ts
        "c.ts": ["d.ts"], "d.ts": ["c.ts"],                             // new
        "x.ts": ["y.ts"], "y.ts": ["x.ts"],                             // unchanged
        "t.test.ts": ["u.ts"], "u.ts": ["t.test.ts"],                   // a test: not counted
        "p.ts": ["q.ts"], "q.ts": ["p.ts"],                             // type-only on one side: no runtime cycle
      },
      typeOnlyEdges: { "q.ts": ["p.ts"] },
    };
    const d = diffSurface(base, head);
    expect(d.cycles).toEqual({ introduced: [["c.ts", "d.ts"]], grown: [{ files: ["a.ts", "b.ts", "e.ts"], added: ["e.ts"] }] });
    expect(d.counts).toMatchObject({ risky: 2, cyclesIntroduced: 2, breaking: 0 });
    const md = renderSurfaceMarkdown(d);
    expect(md).toContain("- 🟠 new: `c.ts` ↔ `d.ts`");
    expect(md).toContain("grown by `e.ts`");
    expect(md).not.toContain("| Change |");
  });

  it("breaks on a body that requires a new field or changes a field's type, not on an optional one", () => {
    const body = (props: Record<string, unknown>, required: string[]) => ({ type: "object" as const, properties: props as never, required });
    const base: S = { routeMap: [route({ path: "/orders", requestSchema: body({ sku: { type: "string" }, qty: { type: "integer" } }, ["sku"]) })] };
    const head: S = { routeMap: [route({ path: "/orders", requestSchema: body({ sku: { type: "string" }, qty: { type: "string" }, note: { type: "string" }, coupon: { type: "string" } }, ["sku", "coupon"]) })] };
    const [c] = diffSurface(base, head).changes;
    expect(c).toMatchObject({ kind: "body-changed", breaking: true });
    // What breaks first, then what only changed.
    expect(c!.reasons).toEqual(["body field qty is string, was integer", "body requires a new field coupon", "body accepts a new field note"]);
    const optionalOnly: S = { routeMap: [route({ path: "/orders", requestSchema: body({ sku: { type: "string" }, qty: { type: "integer" }, note: { type: "string" } }, ["sku"]) })] };
    expect(kinds(base, optionalOnly)).toEqual([["body-changed", false, "POST /orders"]]);
  });

  it("moves a route whose method or path changed under the same handler, and breaks on a parameter binding elsewhere", () => {
    const base: S = { routeMap: [route({ path: "/orders/:id", httpMethod: "PUT", handler: "update", params: [{ name: "id", type: null, binding: "route" }, { name: "dto", type: "Dto", binding: "body" }] })] };
    const head: S = { routeMap: [route({ path: "/orders/:id", httpMethod: "PATCH", handler: "update", params: [{ name: "id", type: null, binding: "route" }, { name: "dto", type: "Dto", binding: "query" }] })] };
    const d = diffSurface(base, head);
    expect(d.changes.map((c) => [c.kind, c.breaking])).toEqual([["param-changed", true], ["route-moved", true]]);
    expect(d.changes.find((c) => c.kind === "route-moved")!.reasons).toEqual(["was PUT /orders/:id"]);
    expect(d.counts).toMatchObject({ routesAdded: 0, routesRemoved: 0 });
  });

  it("marks a route turned anonymous risky, a dropped API version breaking, a deprecation as a change", () => {
    const base: S = { routeMap: [route({ path: "/a", versions: ["1", "2"], auth: { policies: ["Admin"], roles: [], schemes: [] } as never })] };
    const head: S = { routeMap: [route({ path: "/a", versions: ["1", "2"], deprecatedVersions: ["1"], auth: { policies: [], roles: [], schemes: [], anonymous: true } as never })] };
    const d = diffSurface(base, head);
    expect(d.changes.map((c) => [c.kind, c.breaking, c.risky ?? false])).toEqual([["guard-lost", false, true], ["version-deprecated", false, false]]);
    expect(d.changes[0]!.reasons).toEqual(["no longer guarded by Admin", "now allows anonymous callers"]);
    // A frontend page removed breaks no API caller.
    expect(kinds({ routeMap: [route({ path: "/settings", kind: "frontend", httpMethod: null, handler: null })] }, { routeMap: [] })).toEqual([["route-removed", false, "* /settings"]]);
  });

  it("follows calls across tiers: a call reaching another route, a new link, and what a route reaches in data", () => {
    const link = (routePath: string, target = "api/orders.ts") => ({ source: "web/a.ts", sourceLine: 3, method: "GET", url: "/api/orders", target, targetLine: 10, handler: null, routePath, confidence: "EXTRACTED" as const });
    const flow = (resource: string) => ({ entryKind: "route" as const, entryLabel: "POST /orders", entryFile: "api/orders.ts", effect: "db-write" as const, resource, distance: 1, confidence: "INFERRED" as const, path: [] });
    const base: S = { routeMap: [route({ path: "/orders" })], apiRouteLinks: [link("/api/orders")] as never, dataFlows: [flow("order")] as never };
    const head: S = {
      routeMap: [route({ path: "/orders" })],
      apiRouteLinks: [link("/api/v2/orders", "api/v2.ts"), { ...link("/api/orders"), source: "web/b.ts" }] as never,
      dataFlows: [flow("order"), flow("audit_log")] as never,
    };
    const d = diffSurface(base, head);
    expect(d.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(["link-moved", "link-gained", "data-effect-changed"]));
    expect(d.changes.find((c) => c.kind === "data-effect-changed")!.reasons).toEqual(["now reaches db-write audit_log"]);
    expect(d.counts.breaking).toBe(0);
  });
});

const fixture = resolve("test-fixtures/sample-backend");

describe("diffSurface on two analyses", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-surface-"));
    for (const side of ["base", "head"]) {
      await cp(fixture, join(dir, side), { recursive: true });
      await mkdir(join(dir, side, "web"), { recursive: true });
      await writeFile(join(dir, side, "web", "client.ts"), "import axios from 'axios';\nexport const loadUser = (id: number) => axios.get(`/api/users/${id}`);\n");
    }
    // The head drops a guard, adds one, and moves GET /:id.
    const users = join(dir, "head", "routes", "users.ts");
    const src = (await readFile(users, "utf8"))
      .replace("router.delete('/:id', requireAuth, requireAdmin,", "router.delete('/:id', requireAuth,")
      .replace("router.get('/:id', requireAuth,", "router.get('/by-id/:id', requireAuth,")
      .replace("router.put('/:id', requireAuth, async", "router.put('/:id', requireAuth, requireAdmin, async");
    await writeFile(users, src);
    for (const side of ["base", "head"]) {
      await analyze({ projectRoot: join(dir, side), outputDir: join(dir, "out", side), lsp: false, gitHistory: false });
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names each change, with what breaks first", async () => {
    const d = diffSurface(await loadReportSummary(join(dir, "out", "base")), await loadReportSummary(join(dir, "out", "head")));
    expect(d.changes.map((c) => [c.kind, c.route, c.breaking])).toEqual([
      ["link-lost", "GET /api/users/:id", true],
      ["route-moved", "GET /api/users/by-id/:id", true],
      ["guard-added", "PUT /api/users/:id", true],
      ["guard-lost", "DELETE /api/users/:id", false],
    ]);
    expect(renderSurfaceMarkdown(d)).toMatch(/\*\*3 breaking\*\* · 1 risky/);
    const same = await loadReportSummary(join(dir, "out", "base"));
    expect(diffSurface(same, same).counts.total).toBe(0);
  });
});
