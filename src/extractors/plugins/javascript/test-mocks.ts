import type { Node, Tree } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";

/** `vi.mock`, `jest.mock` and their `doMock` forms: the module named is replaced for the test file. */
const MOCK_CALLEE = /^(?:vi|jest)\s*\.\s*(?:mock|doMock)$/;

/** A factory that hands back the module's own functions beside the doubles: the module still runs. */
const KEEPS_ORIGINAL = /\bimportOriginal\b|\bimportActual\b|\brequireActual\b/;

/**
 * The modules a test file replaces with a test double as a whole (`FileAnalysis.mockedModules`):
 * `vi.mock("@/api/clubs")`, `jest.mock("../garage", () => ({ park: jest.fn() }))` — the specifier
 * as written, a literal string only. A partial mock that keeps the original module's exports
 * (`importOriginal()`, `vi.importActual`, `jest.requireActual`) is left out: its other functions run.
 */
export function extractMockedModules(tree: Tree, sourceText: string): string[] {
  if (!/\.\s*(?:mock|doMock)\s*\(/.test(sourceText)) return [];
  const out = new Set<string>();
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = call?.childForFieldName("function");
    if (!callee || callee.type !== "member_expression" || !MOCK_CALLEE.test(callee.text)) continue;
    const args = (call!.childForFieldName("arguments")?.namedChildren ?? []).filter((n): n is Node => !!n && n.type !== "comment");
    const spec = args[0];
    if (!spec || !(spec.type === "string" || (spec.type === "template_string" && !spec.text.includes("${")))) continue;
    if (args[1] && KEEPS_ORIGINAL.test(args[1].text)) continue;
    const source = stripQuotes(spec.text);
    if (source) out.add(source);
  }
  return [...out];
}
