import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { extractTopLevelCalls } from "../../shared/call-graph.js";
import { computeComplexity } from "../../../core/complexity-analyzer.js";

const functionsOf = async (src: string) => {
  const tree = await parseSource(src, "typescript" as never, "test/table.test.ts");
  return new JavaScriptExtractor().extractFunctions(tree, src);
};

describe("test runner callbacks as functions", () => {
  const src = `
import { describe, it, test, expect, beforeEach } from "vitest";
import { buildTable, topClub } from "../src/table";

describe("league", () => {
  let clubs = [];
  beforeEach(() => { clubs = seedClubs(); });

  it("builds", () => {
    expect(buildTable(clubs)[0]).toBe("1. United");
  });

  describe("leader", () => {
    test.each([[1], [2]])("finds the top club %i", async (n) => {
      expect(topClub(clubs)?.name).toBe("United");
    });
    it.skip("ties on points", function () { expect(compareClubs(clubs)).toBe(0); });
  });
});
`;

  it("names each callback by its title path, at any nesting, with the calls of its own body", async () => {
    const fns = await functionsOf(src);
    const byName = new Map(fns.map((f) => [f.name, f]));
    expect([...byName.keys()].filter((n) => n !== "<setup>")).toEqual([
      "league",
      "league › beforeEach",
      "league › builds",
      "league › leader",
      "league › leader › finds the top club %i",
      "league › leader › ties on points",
    ]);
    const names = (n: string) => byName.get(n)!.calls.map((c) => c.name);
    expect(names("league › builds")).toContain("buildTable");
    expect(names("league › beforeEach")).toEqual(["seedClubs"]);
    expect(names("league › leader › finds the top club %i")).toContain("topClub");
    expect(names("league › leader › ties on points")).toContain("compareClubs");
    // A suite gives up what its nested callbacks call, and never calls the registrations.
    expect(names("league")).toEqual([]);
    expect(names("league › leader")).toEqual([]);
    expect(byName.get("league › builds")!.testCase).toEqual({ title: "builds", path: ["league"], kind: "case" });
    expect(byName.get("league › beforeEach")!.testCase).toEqual({ title: "beforeEach", path: ["league"], kind: "hook" });
    expect(byName.get("league › leader")!.testCase).toEqual({ title: "leader", path: ["league"], kind: "suite" });
  });

  it("keeps the callbacks out of the module's setup", async () => {
    const tree = await parseSource(src, "typescript" as never, "test/table.test.ts");
    const setup = extractTopLevelCalls(tree, "typescript" as never).map((c) => c.name);
    expect(setup).not.toContain("buildTable");
    expect(setup).not.toContain("topClub");
  });

  it("reads one-line callbacks, and leaves a member called test alone", async () => {
    const fns = await functionsOf(`
describe("garage", () => { it("parks", () => parkCar(car)); });
export function isPlate(s: string) { return /^[A-Z]+$/.test(s); }
`);
    expect(fns.find((f) => f.name === "garage")!.calls).toEqual([]);
    expect(fns.find((f) => f.name === "garage › parks")!.calls.map((c) => c.name)).toContain("parkCar");
    expect(fns.filter((f) => f.testCase).map((f) => f.name)).toEqual(["garage", "garage › parks"]);
  });

  it("leaves a suite out of complexity: its body is its tests, measured on their own", async () => {
    const code = `
describe("league", () => {
  it("ranks", () => { if (a) { b(); } else if (c) { d(); } });
  it("draws", () => { for (const x of xs) { if (x) e(); } });
});
`;
    const tree = await parseSource(code, "typescript" as never, "test/league.test.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, code);
    const rows = computeComplexity(tree, "typescript" as never, fns, []);
    expect(rows.map((r) => [r.functionName, r.complexity])).toEqual([["league › ranks", 3], ["league › draws", 3]]);
  });
});
