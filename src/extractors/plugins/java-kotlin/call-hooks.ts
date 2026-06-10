import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

/**
 * method_invocation / call_expression have "object" and "name" fields —
 * handle them first to keep the qualifier ("userService.searchUsers", not
 * just "searchUsers").
 */
function resolveJvmCallName(node: Node): string | null {
  if (node.type === "method_invocation" || node.type === "call_expression") {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }
  return genericResolveCallName(node);
}

/** Instance variable → imported type (userService → UserService). */
function capitalizedRoot(root: string): readonly string[] {
  return [root.charAt(0).toUpperCase() + root.slice(1)];
}

const JVM_NESTED_SCOPE_TYPES = [
  "method_declaration", "constructor_declaration", "lambda_expression", "anonymous_class_body",
];

export const javaCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["method_invocation", "object_creation_expression"]),
  nestedScopeTypes: JVM_NESTED_SCOPE_TYPES,
  callbackArgNodeTypes: ["method_invocation"],
  resolveCallName: resolveJvmCallName,
  qualifiedRootCandidates: capitalizedRoot,
};

export const kotlinCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression"]),
  nestedScopeTypes: JVM_NESTED_SCOPE_TYPES,
  callbackArgNodeTypes: ["call_expression"],
  resolveCallName: resolveJvmCallName,
  qualifiedRootCandidates: capitalizedRoot,
};
