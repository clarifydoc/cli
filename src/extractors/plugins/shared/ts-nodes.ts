/** Small walks over a tree-sitter node that the grammar-backed readers of several plugins share. */
import type { TSNode } from "../../../parsers/parser-manager.js";

export function namedChildren(node: TSNode): TSNode[] {
  const out: TSNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
}

export function descendants(node: TSNode, type: string): TSNode[] {
  const out: TSNode[] = [];
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === type) out.push(n);
    for (const c of namedChildren(n)) stack.push(c);
  }
  return out;
}
