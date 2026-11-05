import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";

describe("calls on a module loaded in place", () => {
  it("are the module's member at its path; no phantom default call; the namesake call stays local", async () => {
    const src = `
      export async function a() { (await import('./rules')).promote(1); }
      export function d() { return require('./rules').relegate(4); }
      export async function e() { await import('./rules'); other.promote(2); }`;
    const tree = await parseSource(src, "javascript" as any, "x.js");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const calls = (n: string) => fns.find((f) => f.name === n)!.calls.filter((c) => c.name !== "require").map((c) => [c.name, c.kind, c.target]);
    expect(calls("a")).toEqual([["promote", "cross-file", "./rules"]]);
    expect(calls("d")).toEqual([["relegate", "cross-file", "./rules"]]);
    expect(calls("e")).toEqual([["other.promote", "internal", null]]);
  });
});
