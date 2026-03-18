import type { Node } from "web-tree-sitter";
import type { RouteInfo, CallInfo } from "../../types/analysis.js";
import { extractCalls } from "../shared/call-graph.js";

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
