/** Small readings of JS/TS syntax nodes that several of this plugin's extractors share. */
import type { Node } from "web-tree-sitter";

export function keyOf(pair: Node): string | null {
  const key = pair.childForFieldName("key");
  if (!key) return null;
  if (key.type === "string") return key.text.slice(1, -1);
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  return null;
}

export function pairsOf(obj: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const p of obj.namedChildren) {
    if (p?.type !== "pair") continue;
    const k = keyOf(p);
    const v = p.childForFieldName("value");
    if (k && v) out.set(k, v);
  }
  return out;
}

export function keyText(key: Node | null | undefined): string | null {
  if (!key) return null;
  if (key.type === "property_identifier") return key.text;
  if (key.type === "string") {
    const t = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  }
  return null;
}

/** A call, also awaited or parenthesized (`await apiUrl("/clubs")`); null for anything else. */
export function awaitedCall(node: Node | null): Node | null {
  let n = node;
  while (n?.type === "parenthesized_expression" || n?.type === "await_expression") n = n.namedChild(0);
  return n?.type === "call_expression" ? n : null;
}

/** The innermost declared function holding a line: the narrowest, then the last to start. */
export function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}
