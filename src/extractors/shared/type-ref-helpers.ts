import type { Node } from "web-tree-sitter";
import type { Language, TypeReference, TypeUsageKind } from "../../types/analysis.js";
import { emitTypeRefs, type TypeRefContext } from "./type-parser.js";

/**
 * Shared helpers for the per-plugin AST type-reference walkers
 * (plugins/<lang>/type-references.ts).
 */

/**
 * Thin wrapper that builds a TypeRefContext from the per-walker positional
 * args and delegates emission to the shared `emitTypeRefs`. Keeps the
 * walker call sites unchanged while routing all parsing/dedup through one
 * place.
 */
export function emitParsed(
  rawType: string,
  language: Language,
  kindAtBase: TypeUsageKind,
  filePath: string,
  line: number,
  sourceSymbol: string,
  sourceClass: string | undefined,
  out: TypeReference[],
  confidenceOverride?: "EXTRACTED" | "INFERRED" | "AMBIGUOUS",
): void {
  const ctx: TypeRefContext = { filePath, language, line, sourceSymbol, sourceClass };
  emitTypeRefs(rawType, kindAtBase, ctx, out, confidenceOverride ?? "EXTRACTED");
}

export function findChildByType(node: Node, type: string): Node | null {
  for (const c of node.children) {
    if (c && c.type === type) return c;
  }
  return null;
}

export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function stripLeadingColon(s: string): string {
  return s.trim().replace(/^:\s*/, "");
}
