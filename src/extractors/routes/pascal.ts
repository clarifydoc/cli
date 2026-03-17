import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../types/analysis.js";
import { findChildByType } from "../node-helpers.js";

/** Delphi DataSnap/RAD Server method prefixes that map to HTTP methods */
const DELPHI_METHOD_PREFIXES: Record<string, string> = {
  accept: "GET",
  update: "PUT",
  cancel: "DELETE",
};

/** Pascal / Delphi: DataSnap and RAD Server route patterns */
export function extractPascalRoutes(root: Node, routes: RouteInfo[]): void {
  walkForPascalRoutes(root, routes);
}

function walkForPascalRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "defProc") {
    const declProc = findChildByType(node, "declProc");
    if (!declProc) { recurse(node, routes); return; }

    let className = "";
    let methodName = "";
    for (let i = 0; i < declProc.childCount; i++) {
      const child = declProc.child(i)!;
      if (child.type === "genericDot") {
        const parts: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          if (child.child(j)!.type === "identifier") parts.push(child.child(j)!.text);
        }
        if (parts.length >= 2) {
          className = parts[0];
          methodName = parts[parts.length - 1];
        }
      }
    }

    if (className && methodName) {
      const lowerName = methodName.toLowerCase();
      for (const [prefix, method] of Object.entries(DELPHI_METHOD_PREFIXES)) {
        if (lowerName.startsWith(prefix) && lowerName.length > prefix.length) {
          const path = "/" + methodName.slice(prefix.length);
          routes.push({
            path,
            httpMethod: method,
            kind: "api",
            handler: `${className}.${methodName}`,
            calls: [],
            middleware: [],
            line: node.startPosition.row + 1,
          });
          break;
        }
      }
    }
  }

  recurse(node, routes);
}

function recurse(node: Node, routes: RouteInfo[]) {
  for (let i = 0; i < node.childCount; i++) {
    walkForPascalRoutes(node.child(i)!, routes);
  }
}
