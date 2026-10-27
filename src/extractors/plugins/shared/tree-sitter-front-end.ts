import type { ParsedStructure } from "../../../types/language-plugin.js";
import { getGrammarParser, type TSNode } from "../../../parsers/parser-manager.js";
import { normalizeSource } from "../../../parsers/normalize-source.js";

/**
 * A regex language's tree-sitter front end (`meta.treeSitter`): the registered grammar's parser, loaded once,
 * reading normalized source (so rows are the lines `splitLines` counts) and freeing each tree after `read`.
 */
export async function treeSitterReader(grammar: string, read: (root: TSNode, text: string) => ParsedStructure): Promise<(source: string) => ParsedStructure> {
  const parser = await getGrammarParser(grammar);
  return (source) => {
    const text = normalizeSource(source);
    const tree = parser.parse(text);
    if (!tree) throw new Error(`tree-sitter-${grammar} returned no tree`);
    try {
      return read(tree.rootNode, text);
    } finally {
      tree.delete();
    }
  };
}

/** The ERROR and MISSING nodes of a tree; at least 1 when the root says it has an error. */
export function countSyntaxErrors(root: TSNode): number {
  if (!root.hasError) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      count++;
      continue;
    }
    if (!node.hasError) continue;
    for (let i = 0; i < node.childCount; i++) stack.push(node.child(i)!);
  }
  // A node can carry the flag with no error node under it; the file still did not parse cleanly.
  return Math.max(count, 1);
}
