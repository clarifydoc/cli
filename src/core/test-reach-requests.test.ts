import { describe, it, expect } from "vitest";
import { testsReachingEach, type ReachSummary } from "./test-functions.js";
import type { SymbolLink } from "../types/analysis.js";

const link = (from: string, to: string, extra: Partial<SymbolLink> = {}): SymbolLink => {
  const [sourceFile, sourceSymbol] = from.split("::") as [string, string];
  const [targetFile, targetSymbol] = to.split("::") as [string, string];
  return { sourceFile, sourceSymbol, sourceLine: 1, callName: targetSymbol, targetFile, targetSymbol, targetLine: 1, confidence: "EXTRACTED", ...extra };
};
const http = { strategy: "api-route", relation: "http" } as const;

/** A test requesting a route runs its handler only when the request is the server's own test client. */
const summary: ReachSummary = {
  fileLayerMap: {},
  testFunctions: {},
  fileProjects: {
    "league/tests/test_clubs.py": "league",
    "league/views.py": "league",
    "league/standings.py": "league",
    "scouting/tests/test_feed.py": "scouting",
    "web/src/api.ts": "web",
    "web/src/api.test.ts": "web",
  },
  routeMap: [
    { filePath: "league/views.py", httpMethod: "GET", path: "/api/admin/", middleware: ["login_required"] },
    { filePath: "league/views.py", httpMethod: "GET", path: "/api/audit/", middleware: [] },
  ] as unknown as ReachSummary["routeMap"],
  symbolLinks: [
    // The server's own test client requests GET /api/clubs/.
    link("league/tests/test_clubs.py::TestClubs.test_list", "league/views.py::route:GET /api/clubs/", http),
    link("league/views.py::route:GET /api/clubs/", "league/views.py::ClubList.get"),
    link("league/views.py::ClubList.get", "league/standings.py::table"),
    // A frontend client, tested with the network mocked, requests GET /api/transfers/.
    link("web/src/api.test.ts::loads transfers", "web/src/api.ts::fetchTransfers"),
    link("web/src/api.ts::fetchTransfers", "league/views.py::route:GET /api/transfers/", http),
    link("web/src/api.test.ts::posts a bid", "league/views.py::route:POST /api/bids/", http),
    link("league/views.py::route:GET /api/transfers/", "league/views.py::TransferList.get"),
    link("league/views.py::route:POST /api/bids/", "league/views.py::BidCreate.post"),
    // A guarded route requested only by a test whose caller is turned away, and an open one.
    link("league/tests/test_clubs.py::TestClubs.when unauthenticated › returns unauthorized", "league/views.py::route:GET /api/admin/", http),
    link("league/views.py::route:GET /api/admin/", "league/views.py::AdminPanel.get"),
    link("league/tests/test_clubs.py::TestClubs.test_unauthorized_is_logged", "league/views.py::route:GET /api/audit/", http),
    link("league/views.py::route:GET /api/audit/", "league/views.py::AuditLog.get"),
    // Another service's tests, in the same language, request GET /api/fixtures/.
    link("scouting/tests/test_feed.py::test_fixtures", "league/views.py::route:GET /api/fixtures/", http),
    link("league/views.py::route:GET /api/fixtures/", "league/views.py::FixtureList.get"),
  ],
};

describe("test reach through a route", () => {
  const reach = testsReachingEach(summary, [
    { file: "league/standings.py", symbol: "table" },
    { file: "league/views.py", symbol: "TransferList.get" },
    { file: "league/views.py", symbol: "BidCreate.post" },
    { file: "league/views.py", symbol: "FixtureList.get" },
    { file: "league/views.py", symbol: "AdminPanel.get" },
    { file: "league/views.py", symbol: "AuditLog.get" },
  ]);

  it("crosses the route a test requests in-process, on to what its handler calls", () => {
    expect(reach.get("league/standings.py::table")).toMatchObject({
      test: { file: "league/tests/test_clubs.py", symbol: "TestClubs.test_list" },
      depth: 3,
      via: ["route:GET /api/clubs/", "ClubList.get"],
    });
  });

  it("never crosses a request from production code, another language's tests or another sub-project's", () => {
    expect(reach.has("league/views.py::TransferList.get")).toBe(false);
    expect(reach.has("league/views.py::BidCreate.post")).toBe(false);
    expect(reach.has("league/views.py::FixtureList.get")).toBe(false);
  });

  it("never credits a guarded route's action to a test whose caller is turned away; an open route's it does", () => {
    expect(reach.has("league/views.py::AdminPanel.get")).toBe(false);
    expect(reach.get("league/views.py::AuditLog.get")?.test.symbol).toBe("TestClubs.test_unauthorized_is_logged");
  });
});
