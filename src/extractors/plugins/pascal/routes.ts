import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import { findChildByType } from "../../shared/node-helpers.js";
import type { RouteExtractor } from "../../routes/base.js";

/** Delphi DataSnap/RAD Server method prefixes that map to HTTP methods */
const DELPHI_METHOD_PREFIXES: Record<string, string> = {
  accept: "GET",
  update: "PUT",
  cancel: "DELETE",
};

/**
 * The method-name convention above only means anything inside a DataSnap /
 * RAD Server module — on an ordinary VCL form, `UpdateAll` is just a method.
 * Require framework evidence in the unit text before running the heuristic
 * (a desktop corpus otherwise sprouts a phantom `PUT /All` per Update* method).
 */
const DATASNAP_EVIDENCE_RE =
  /\b(Datasnap\.|DSServer|DSHTTP|DSProviderDataModuleAdapter|TDSServerModule|EMS\.|TEMSResource|EMSEndpoint|ResourceSuffix)\b/;

/** Pascal / Delphi: DataSnap and RAD Server route patterns */
export function extractPascalRoutes(root: Node, routes: RouteInfo[], sourceText?: string): void {
  if (sourceText !== undefined && !DATASNAP_EVIDENCE_RE.test(sourceText)) return;
  walkForPascalRoutes(root, routes);
}

function walkForPascalRoutes(node: Node, routes: RouteInfo[]) {
  if (node.type === "defProc") {
    const declProc = findChildByType(node, "declProc");
    if (!declProc) { recurse(node, routes); return; }

    let className = "";
    let methodName = "";
    for (const child of declProc.children) {
      if (child.type === "genericDot") {
        const parts: string[] = [];
        for (const part of child.children) {
          if (part.type === "identifier") parts.push(part.text);
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
  for (const child of node.children) {
    walkForPascalRoutes(child, routes);
  }
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const pascalRouteExtractor: RouteExtractor = {
  languages: ["pascal"],
  extractRoutes(tree, sourceText) {
    const routes: RouteInfo[] = [];
    extractPascalRoutes(tree.rootNode, routes, sourceText);
    return routes;
  },
};
