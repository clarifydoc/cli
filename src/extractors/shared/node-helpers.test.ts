import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers tree-sitter grammars
import type { Node } from "web-tree-sitter";
import { parseSource } from "../../parsers/parser-manager.js";
import { enclosingFunctionNode, literalString, paramNames } from "./node-helpers.js";

async function valueOf(code: string): Promise<Node> {
  const tree = await parseSource(`const x = ${code};`, "typescript", "x.ts");
  return tree.rootNode.descendantsOfType("variable_declarator")[0]!.childForFieldName("value")!;
}

describe("literalString", () => {
  it("reads strings through as const, satisfies, parentheses and !", async () => {
    for (const code of [`"/clubs"`, `"/clubs" as const`, `("/clubs")`, `"/clubs"!`, `"/clubs" satisfies string`, "`/clubs`"]) {
      expect(literalString(await valueOf(code)), code).toBe("/clubs");
    }
  });

  it("refuses a template with a hole unless asked to keep it", async () => {
    const value = await valueOf("`/clubs/${id}`");
    expect(literalString(value)).toBeNull();
    expect(literalString(value, { holes: true })).toBe("/clubs/${id}");
  });

  it("looks through .replace only when asked", async () => {
    const value = await valueOf("`/clubs/{id}`.replace('{id}', id)");
    expect(literalString(value)).toBeNull();
    expect(literalString(value, { replace: true })).toBe("/clubs/{id}");
  });

  it("is null for a non-literal", async () => {
    expect(literalString(await valueOf("clubPath"))).toBeNull();
  });
});

describe("function helpers", () => {
  it("finds the enclosing function, generators included, and its parameter names", async () => {
    const tree = await parseSource("function* kickoff(club, { id }, p = 1) { run(); }", "typescript", "x.ts");
    const call = tree.rootNode.descendantsOfType("call_expression")[0]!;
    const fn = enclosingFunctionNode(call)!;
    expect(fn.type).toBe("generator_function_declaration");
    expect(paramNames(fn)).toEqual(["club", "", "p"]);
    expect(enclosingFunctionNode(tree.rootNode)).toBeNull();
  });
});
