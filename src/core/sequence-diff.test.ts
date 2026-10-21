import { describe, it, expect } from "vitest";
import type { ProjectAnalysis } from "../types/analysis.js";
import { diffSequences, renderSequenceDiff, sequenceTree } from "./sequence-diff.js";

const link = (from: string, to: string, line: number, relation = "call") => ({
  sourceFile: "a.ts", sourceSymbol: from, sourceLine: line, targetFile: "a.ts", targetSymbol: to, targetLine: 100, callName: to, relation, confidence: "EXTRACTED",
});
const analysis = (links: ReturnType<typeof link>[], access: Array<{ symbol: string; entity: string; access: string }> = []) =>
  ({ symbolLinks: links, symbolDataAccess: access.map((a) => ({ file: "a.ts", symbolLine: 1, sites: [], ...a })) }) as unknown as ProjectAnalysis;
const seed = { file: "a.ts", symbol: "route:POST /cars" };

describe("sequence diff", () => {
  it("names the steps a change added, removed and moved, by what they are rather than their lines", () => {
    const base = analysis([
      link("route:POST /cars", "Cars.place", 3),
      link("Cars.place", "Cars.validate", 10),
      link("Cars.place", "Audit.log", 11),
      link("Cars.place", "Mail.send", 12),
    ], [{ symbol: "Cars.place", entity: "cars", access: "write" }]);
    // Head: validate kept (on another line), Mail.send gone, Payments.charge new, Audit.log moved under validate.
    const head = analysis([
      link("route:POST /cars", "Cars.place", 5),
      link("Cars.place", "Cars.validate", 20),
      link("Cars.validate", "Audit.log", 40),
      link("Cars.place", "Payments.charge", 21),
    ], [{ symbol: "Cars.place", entity: "cars", access: "write" }]);
    const changes = diffSequences(sequenceTree(base, seed), sequenceTree(head, seed));
    expect(changes).toEqual([
      { kind: "moved", path: ["POST /cars", "Cars.place()", "Cars.validate()"], step: "Audit.log()", from: ["POST /cars", "Cars.place()"] },
      { kind: "removed", path: ["POST /cars", "Cars.place()"], step: "Mail.send()" },
      { kind: "added", path: ["POST /cars", "Cars.place()"], step: "Payments.charge()" },
    ]);
    expect(renderSequenceDiff("POST /cars", changes)).toBe(
      "POST /cars: 3 changes in the flow\n" +
      "  ~ Audit.log() moved: from Cars.place() to Cars.place() → Cars.validate()\n" +
      "  - Mail.send() (was called from Cars.place())\n" +
      "  + Payments.charge() (now called from Cars.place())\n",
    );
  });

  it("says the flow is unchanged when only lines moved, and sees a data effect come and go", () => {
    const one = analysis([link("route:POST /cars", "Cars.place", 3)], [{ symbol: "Cars.place", entity: "cars", access: "write" }]);
    const moved = analysis([link("route:POST /cars", "Cars.place", 30)], [{ symbol: "Cars.place", entity: "cars", access: "write" }]);
    expect(renderSequenceDiff("POST /cars", diffSequences(sequenceTree(one, seed), sequenceTree(moved, seed)))).toBe("POST /cars: the flow is unchanged.\n");
    const reads = analysis([link("route:POST /cars", "Cars.place", 3)], [{ symbol: "Cars.place", entity: "cars", access: "read" }]);
    expect(diffSequences(sequenceTree(one, seed), sequenceTree(reads, seed)).map((c) => `${c.kind} ${c.step}`)).toEqual(["removed DB cars: write", "added DB cars: read"]);
  });
});

describe("flow locks", () => {
  it("records every API route's flow and reports the ones that changed, appeared or went", async () => {
    const { checkFlowLock, flowLock } = await import("./sequence-diff.js");
    const routes = [
      { path: "/cars", httpMethod: "POST", kind: "api", filePath: "a.ts", line: 1 },
      { path: "/health", httpMethod: "GET", kind: "api", filePath: "a.ts", line: 2 },
      { path: "/", httpMethod: null, kind: "frontend", filePath: "app.tsx", line: 1 },
    ];
    const at = (r: { httpMethod: string | null; path: string }) => `route:${r.httpMethod} ${r.path}`;
    const base = { ...analysis([link("route:POST /cars", "Cars.place", 3), link("route:GET /health", "ping", 1)]), routeMap: routes } as unknown as ProjectAnalysis;
    const lock = flowLock(base, at);
    expect(Object.keys(lock.flows)).toEqual(["GET /health", "POST /cars"]);
    expect(checkFlowLock(lock, flowLock(base, at))).toEqual([]);
    const head = { ...analysis([link("route:POST /cars", "Cars.place", 3), link("Cars.place", "Mail.send", 9), link("route:GET /ready", "ping", 1)]), routeMap: [routes[0], { ...routes[1]!, path: "/ready" }] } as unknown as ProjectAnalysis;
    expect(checkFlowLock(lock, flowLock(head, at))).toEqual([
      "GET /ready: new — not in the lock.\n",
      "POST /cars: 1 change in the flow\n  + Mail.send() (now called from Cars.place())\n",
      "GET /health: gone — in the lock, no longer a route with a flow.\n",
    ]);
  });
});
