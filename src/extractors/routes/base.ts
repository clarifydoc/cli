import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo, CallInfo, Language } from "../../types/analysis.js";
import { extractCalls } from "../shared/call-graph.js";

/**
 * A language plugin's route extractor. One per language family; a plugin
 * that supports several frameworks (e.g. JS: Express, React Router, NestJS,
 * Vue Router) runs them all inside its `extractRoutes` — the order it runs
 * them in is the order routes appear in the output.
 */
export interface RouteExtractor {
  /** Languages this extractor handles */
  readonly languages: Language[];

  /** Extract all routes/endpoints from the AST. */
  extractRoutes(tree: Tree, sourceText: string): RouteInfo[];
}

export const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "use",
  "head",
  "options",
]);

/** Collect function calls from within a function body.
 *  Delegates to the shared call-graph extractor for JS/TS. */
export function collectCallNames(fnNode: Node): CallInfo[] {
  return extractCalls(fnNode, "typescript");
}

/** Create a RouteInfo with defaults for calls/middleware. */
export function route(info: Omit<RouteInfo, "calls" | "middleware"> & { calls?: CallInfo[]; middleware?: string[] }): RouteInfo {
  return {
    ...info,
    calls: info.calls ?? [],
    middleware: info.middleware ?? [],
  };
}
