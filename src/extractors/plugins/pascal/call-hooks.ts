import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

export const pascalCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["exprCall"]),

  // exprCall with exprDot, identifier, or inherited as callee
  resolveCallName: (node) => genericResolveCallName(node, {
    extraCallee(callee, n) {
      if (n.type === "exprCall") {
        if (callee.type === "exprDot") return callee.text;
        if (callee.type === "identifier") return callee.text;
        if (callee.type === "inherited") return callee.text;
      }
      return null;
    },
  }),

  // Delphi fields prefixed with F: FUserService.Save → UserService
  qualifiedRootCandidates(root) {
    if (root.startsWith("F") && root.length > 1) return [root.slice(1)];
    return [];
  },
};
