import { describe, it, expect } from "vitest";
import type { ProjectAnalysis } from "../types/analysis.js";
import { diffSequences, renderSequenceDiff, sequenceTree } from "./sequence-diff.js";

const link = (from: string, to: string, line: number, relation = "call") => ({
  sourceFile: "a.ts", sourceSymbol: from, sourceLine: line, targetFile: "a.ts", targetSymbol: to, targetLine: 100, callName: to, relation, confidence: "EXTRACTED",
});
const analysis = (links: ReturnType<typeof link>[], access: Array<{ symbol: string; entity: string; access: string }> = []) =>
  ({ symbolLinks: links, symbolDataAccess: access.map((a) => ({ file: "a.ts", symbolLine: 1, sites: [], ...a })) }) as unknown as ProjectAnalysis;
const seed = { file: "a.ts", symbol: "route:POST /orders" };

describe("sequence diff", () => {
  it("names the steps a change added, removed and moved, by what they are rather than their lines", () => {
    const base = analysis([
      link("route:POST /orders", "Orders.place", 3),
      link("Orders.place", "Orders.validate", 10),
      link("Orders.place", "Audit.log", 11),
      link("Orders.place", "Mail.send", 12),
    ], [{ symbol: "Orders.place", entity: "orders", access: "write" }]);
    // Head: validate kept (on another line), Mail.send gone, Payments.charge new, Audit.log moved under validate.
    const head = analysis([
      link("route:POST /orders", "Orders.place", 5),
      link("Orders.place", "Orders.validate", 20),
      link("Orders.validate", "Audit.log", 40),
      link("Orders.place", "Payments.charge", 21),
    ], [{ symbol: "Orders.place", entity: "orders", access: "write" }]);
    const changes = diffSequences(sequenceTree(base, seed), sequenceTree(head, seed));
    expect(changes).toEqual([
      { kind: "moved", path: ["POST /orders", "Orders.place()", "Orders.validate()"], step: "Audit.log()", from: ["POST /orders", "Orders.place()"] },
      { kind: "removed", path: ["POST /orders", "Orders.place()"], step: "Mail.send()" },
      { kind: "added", path: ["POST /orders", "Orders.place()"], step: "Payments.charge()" },
    ]);
    expect(renderSequenceDiff("POST /orders", changes)).toBe(
      "POST /orders: 3 changes in the flow\n" +
      "  ~ Audit.log() moved: from Orders.place() to Orders.place() → Orders.validate()\n" +
      "  - Mail.send() (was called from Orders.place())\n" +
      "  + Payments.charge() (now called from Orders.place())\n",
    );
  });

  it("says the flow is unchanged when only lines moved, and sees a data effect come and go", () => {
    const one = analysis([link("route:POST /orders", "Orders.place", 3)], [{ symbol: "Orders.place", entity: "orders", access: "write" }]);
    const moved = analysis([link("route:POST /orders", "Orders.place", 30)], [{ symbol: "Orders.place", entity: "orders", access: "write" }]);
    expect(renderSequenceDiff("POST /orders", diffSequences(sequenceTree(one, seed), sequenceTree(moved, seed)))).toBe("POST /orders: the flow is unchanged.\n");
    const reads = analysis([link("route:POST /orders", "Orders.place", 3)], [{ symbol: "Orders.place", entity: "orders", access: "read" }]);
    expect(diffSequences(sequenceTree(one, seed), sequenceTree(reads, seed)).map((c) => `${c.kind} ${c.step}`)).toEqual(["removed DB orders: write", "added DB orders: read"]);
  });
});
