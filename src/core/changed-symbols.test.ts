import { describe, it, expect } from "vitest";
import { parseUnifiedHunks, reverseSymbolReach, symbolsInHunks } from "./changed-symbols.js";
import type { SymbolLink } from "../types/analysis.js";

describe("parseUnifiedHunks", () => {
  it("reads new-side ranges, a pure deletion as the line it sat before", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3,2 +3,4 @@ function x() {",
      "@@ -20 +22 @@",
      "@@ -30,3 +31,0 @@",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
    ].join("\n");
    expect([...parseUnifiedHunks(diff)]).toEqual([["src/a.ts", [[3, 6], [22, 22], [31, 31]]]]);
  });
});

describe("symbolsInHunks + reverseSymbolReach", () => {
  const analyses = new Map([
    ["svc.ts", {
      functions: [{ name: "helper", line: 1, endLine: 4 }, { name: "<setup>", line: 1, endLine: 40 }],
      classes: [{ name: "OrderService", methods: [{ name: "place", line: 10, endLine: 20 }, { name: "cancel", line: 22, endLine: 30 }] }],
    } as never],
  ]);
  it("maps hunks to the innermost function, and lines outside any to the file", () => {
    const { symbols, moduleLevel } = symbolsInHunks(analyses, new Map([["svc.ts", [[12, 13], [35, 36]]], ["new.ts", [[1, 9]]]]));
    expect(symbols.map((s) => s.symbol)).toEqual(["OrderService.place"]);
    expect(moduleLevel).toEqual(["new.ts", "svc.ts"]);
  });

  it("walks callers back, weakest link kept, routes included", () => {
    const link = (sf: string, ss: string, tf: string, ts: string, confidence: string): SymbolLink =>
      ({ sourceFile: sf, sourceSymbol: ss, sourceLine: 1, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence } as SymbolLink);
    const callers = reverseSymbolReach([
      link("ctl.ts", "OrderController.create", "svc.ts", "OrderService.place", "EXTRACTED"),
      link("ctl.ts", "route:POST /orders", "ctl.ts", "OrderController.create", "INFERRED"),
      link("other.ts", "unrelated", "svc.ts", "OrderService.cancel", "EXTRACTED"),
    ], [{ file: "svc.ts", symbol: "OrderService.place", line: 10, endLine: 20 }]);
    expect(callers.map((c) => [c.symbol, c.depth, c.confidence])).toEqual([
      ["OrderController.create", 1, "EXTRACTED"],
      ["route:POST /orders", 2, "INFERRED"],
    ]);
  });
});
