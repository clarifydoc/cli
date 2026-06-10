import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

export const pythonCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call"]),
  nestedScopeTypes: ["function_definition", "class_definition", "lambda"],
  callbackArgNodeTypes: ["call"],

  resolveCallName(node) {
    // Python `call` nodes resolve via the "function" field, falling back to
    // the first child (never the constructor/name fields other grammars use).
    if (node.type === "call") {
      return genericResolveCallName(node, {
        calleeOverride: node.childForFieldName("function") ?? node.child(0),
      });
    }
    return genericResolveCallName(node);
  },

  // @decorator counts as a call to decorator
  collectExtraCalls(node, addResult, resolve) {
    if (node.type === "decorator") {
      const expr = node.child(1); // after @
      if (expr) {
        const name = expr.type === "call" ? resolve(expr) : expr.text;
        if (name) addResult(name, expr);
      }
    }
  },

  // snake_case instance → PascalCase import (user_service → UserService)
  qualifiedRootCandidates(root) {
    if (!root.includes("_")) return [];
    return [root.split("_").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("")];
  },
};
