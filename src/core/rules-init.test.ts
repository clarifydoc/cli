import { describe, expect, it } from "vitest";
import { initialRules, mergeRules, unitOf, violationsOf } from "./rules-init.js";

const graph = {
  "ui/page.ts": ["services/club.ts"],
  "services/club.ts": ["domain/match.ts"],
  "domain/match.ts": [],
  "league/table.ts": ["garage/car.ts"],
  "garage/car.ts": ["league/table.ts"],
  "main.ts": ["ui/page.ts"],
};

describe("rules init", () => {
  it("cuts units by folder depth and leaves root files out", () => {
    expect(unitOf("main.ts", 2)).toBeNull();
    expect(unitOf("ui/page.ts", 2)).toBe("ui");
    expect(unitOf("ui/forms/a.ts", 2)).toBe("ui/forms");
    expect(unitOf("ui/forms/a.ts", 1)).toBe("ui");
  });

  it("forbids the way back up for acyclic units, not an order between unrelated ones", () => {
    const { rules, cycles } = initialRules(graph, 2);
    const down = rules.find((r) => r.name === "layering: domain stays below its dependents")!;
    expect(down.to).toEqual(["services/**", "ui/**"]);
    expect(rules.find((r) => r.name === "layering: ui stays below its dependents")).toBeUndefined();
    expect(rules.some((r) => r.from[0] === "league/**" && r.to.includes("ui/**"))).toBe(false);
    expect(cycles).toEqual([["garage", "league"]]);
    expect(rules.find((r) => r.name === "layering: league stays out of its cycle")!.to).toEqual(["garage/**"]);
  });

  it("holds today except inside cycles, and breaks on a new upward import", () => {
    const { rules } = initialRules(graph, 2);
    expect(violationsOf(graph, rules).map((v) => v.sourceFile).sort()).toEqual(["garage/car.ts", "league/table.ts"]);
    const drift = { ...graph, "domain/match.ts": ["ui/page.ts"] };
    const after = violationsOf(drift, rules).filter((v) => !["garage/car.ts", "league/table.ts"].includes(v.sourceFile));
    expect(after.map((v) => v.sourceFile)).toEqual(["domain/match.ts"]);
  });

  it("scopes a unit that holds deeper units to its own files", () => {
    const g = { "app/x.ts": ["app/ui/y.ts"], "app/ui/y.ts": [], "app/ui/z.ts": ["app/x.ts"] };
    const { rules } = initialRules(g, 2);
    expect(rules.flatMap((r) => [...r.from, ...r.to])).toContain("app/*");
  });

  it("merges by rule name and keeps the team's own", () => {
    const { rules } = initialRules(graph, 2);
    const { added, kept } = mergeRules([{ name: rules[0]!.name }, { name: "mine" }], rules);
    expect(kept).toEqual([rules[0]!.name]);
    expect(added.length).toBe(rules.length - 1);
  });
});
