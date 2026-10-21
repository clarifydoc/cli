import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Screen → endpoint → table on `test-fixtures/sample-expo-app`, against labels
 * written BY HAND from that fixture's source.
 *
 *   mobile/   Expo Router app in a sub-folder (its own package.json names
 *             expo-router). Files under app/ are screens at their path:
 *             (tabs)/index → /, (tabs)/settings → /settings, drill/[id] →
 *             /drill/:id. _layout files and +not-found are not routes;
 *             health+api.ts serves GET /health.
 *             lib/api.ts calls the server with `${BASE}/api/…` (BASE from
 *             EXPO_PUBLIC_API_URL, falling back to http://localhost:4000).
 *   server/   Express with inline handlers; each runs raw SQL through a pg
 *             Pool imported from ./db — two reads and one write of `drills`.
 *
 * The chain closes only if the screens are routed from a sub-folder, the
 * driver call's SQL names its table, and an inline handler's query belongs to
 * its route.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-expo-app");

const SCREEN_ROUTES = [
  "frontend / mobile/app/(tabs)/index.tsx",
  "frontend /settings mobile/app/(tabs)/settings.tsx",
  "frontend /drill/:id mobile/app/drill/[id].tsx",
];

const LINKS = [
  { call: "mobile/lib/api.ts:10", route: "GET /api/drills" },
  { call: "mobile/lib/api.ts:15", route: "GET /api/drills/:id" },
  { call: "mobile/lib/api.ts:20", route: "PATCH /api/drills/:id/complete" },
];

const SCREEN_EFFECTS = [
  "DrillListScreen db-read drills",
  "DrillScreen db-read drills",
  "DrillScreen db-write drills",
];

const ROUTE_EFFECTS = [
  "GET /api/drills db-read drills",
  "GET /api/drills/:id db-read drills",
  "PATCH /api/drills/:id/complete db-write drills",
];

describe("sample-expo-app: an Expo screen to the table its endpoint writes", () => {
  let out = "";
  let s: ProjectAnalysis;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-expo-"));
    await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    s = await loadReportSummary(out);
  }, 120_000);

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("routes every screen file from the app's own folder, and nothing else under app/", () => {
    const frontend = s.routeMap
      .filter((r) => r.kind === "frontend")
      .map((r) => `${r.kind} ${r.path} ${r.filePath}`)
      .sort();
    expect(frontend).toEqual([...SCREEN_ROUTES].sort());
    const api = s.routeMap.filter((r) => r.filePath?.startsWith("mobile/")).filter((r) => r.kind === "api");
    expect(api.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /health"]);
  });

  it("links each client call to the Express route that serves it", () => {
    const got = (s.apiRouteLinks ?? []).map((l) => ({
      call: `${l.source}:${l.sourceLine}`,
      route: `${l.method ?? "GET"} ${l.routePath}`,
    }));
    for (const want of LINKS) expect(got).toContainEqual(want);
  });

  it("follows each route to the table its SQL reads or writes", () => {
    const effects = (s.dataFlows ?? [])
      .filter((f) => f.entryKind === "route" && f.effect.startsWith("db-"))
      .map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`)
      .sort();
    expect(effects).toEqual([...ROUTE_EFFECTS].sort());
  });

  it("follows each screen across HTTP to the same tables", () => {
    const effects = (s.dataFlows ?? [])
      .filter((f) => f.entryKind === "screen" && f.effect.startsWith("db-"))
      .map((f) => `${f.entryLabel.split(" ")[0]} ${f.effect} ${f.resource}`)
      .sort();
    expect(effects).toEqual([...SCREEN_EFFECTS].sort());
  });
});
