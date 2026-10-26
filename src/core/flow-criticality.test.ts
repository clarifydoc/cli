import { describe, it, expect } from "vitest";
import { rankDataFlows, describeFlowReasons } from "./flow-criticality.js";
import type { DataFlowPath, RouteInfo, SecurityIssue } from "../types/analysis.js";

const flow = (entryLabel: string, effect: DataFlowPath["effect"], resource: string, extra: Partial<DataFlowPath> = {}): DataFlowPath => ({
  entryKind: "route",
  entryLabel,
  entryFile: "src/routes/clubs.ts",
  effect,
  resource,
  distance: 1,
  confidence: "INFERRED",
  ...extra,
});

const route = (method: string, path: string, anonymous: boolean): RouteInfo & { filePath: string } =>
  ({ path, httpMethod: method, kind: "api", filePath: "src/routes/clubs.ts", line: 1, handler: null, auth: { policies: [], roles: [], schemes: [], anonymous } }) as never;

describe("rankDataFlows", () => {
  it("puts a shared anonymous write above a guarded write and a read, with its reasons", () => {
    const flows = [
      flow("GET /api/v2/clubs", "db-read", "clubs"),
      flow("PUT /api/v2/clubs/:id", "db-write", "clubs"),
      flow("POST /api/v2/signups", "db-write", "players", {
        via: [
          { file: "src/routes/clubs.ts", symbol: "signup", line: 4 },
          { file: "src/services/squad.ts", symbol: "SquadService.add", line: 9 },
          { file: "src/repos/players.ts", symbol: "PlayerRepo.save" },
        ],
      }),
      flow("POST /api/v2/transfers", "db-write", "players", { entryFile: "src/routes/transfers.ts" }),
      flow("POST /api/v2/loans", "db-write", "players", { entryFile: "src/routes/loans.ts" }),
    ];
    const issues = [{ category: "sql-injection", severity: "high", filePath: "src/services/squad.ts", line: 9, message: "", snippet: "" }] as SecurityIssue[];
    const pressing = rankDataFlows(flows, { routes: [route("POST", "/api/v2/signups", true), route("PUT", "/api/v2/clubs/:id", false)], securityIssues: issues });

    expect(flows[0]!.entryLabel).toBe("POST /api/v2/signups");
    expect(flows[0]!.criticality).toMatchObject({ level: "critical", sharedBy: 3 });
    expect(flows[0]!.criticality!.reasons).toEqual(["writes", "anonymous_entry", "shared_resource", "wide_path", "finding_on_path"]);
    expect(flows.at(-1)!.entryLabel).toBe("GET /api/v2/clubs");
    expect(flows.at(-1)!.criticality).toMatchObject({ level: "low", reasons: ["reads"] });
    expect(flows.find((f) => f.entryLabel === "PUT /api/v2/clubs/:id")!.criticality!.level).toBe("medium");
    // The other two writes of `players` share it with only three entry points: medium.
    expect(pressing).toBe(1);
    expect(describeFlowReasons(["writes", "anonymous_entry"])).toBe("writes data, its route allows anonymous callers");
  });

  it("discounts a flow whose path crosses a heuristic link", () => {
    const flows = [flow("POST /api/v2/matches", "db-write", "matches", { confidence: "AMBIGUOUS" })];
    rankDataFlows(flows, { routes: [], securityIssues: [] });
    expect(flows[0]!.criticality).toMatchObject({ score: 28, reasons: ["writes", "ambiguous_link"] });
  });
});
