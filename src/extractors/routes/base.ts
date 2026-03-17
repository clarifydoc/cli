import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";

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

/** Collect function call names from within a function body (non-recursive into nested functions) */
export function collectCallNames(fnNode: Node): string[] {
  const names: string[] = [];
  const visited = new Set<number>();

  function walk(n: Node) {
    if (visited.has(n.id)) return;
    visited.add(n.id);

    // Don't descend into nested function definitions
    if (
      n !== fnNode &&
      (n.type === "arrow_function" ||
        n.type === "function_expression" ||
        n.type === "function_declaration")
    ) {
      return;
    }

    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee) {
        const name =
          callee.type === "identifier"
            ? callee.text
            : callee.type === "member_expression"
              ? callee.childForFieldName("property")?.text ?? null
              : callee.type === "await_expression"
                ? collectCallNames(callee)[0] ?? null
                : null;
        if (name && !["then", "json", "send", "status", "catch"].includes(name)) {
          names.push(name);
        }
      }
    }

    // For await expressions wrapping calls: `await createUser(req.body)`
    if (n.type === "await_expression") {
      const child = n.child(1); // the expression after 'await'
      if (child?.type === "call_expression") {
        const callee = child.childForFieldName("function");
        if (callee?.type === "identifier") {
          if (!names.includes(callee.text)) {
            names.push(callee.text);
          }
        }
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }

  walk(fnNode);
  return [...new Set(names)];
}

/** Create a RouteInfo with defaults for calls/middleware. */
export function route(info: Omit<RouteInfo, "calls" | "middleware"> & { calls?: string[]; middleware?: string[] }): RouteInfo {
  return {
    ...info,
    calls: info.calls ?? [],
    middleware: info.middleware ?? [],
  };
}
