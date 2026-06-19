import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

/**
 * Resolve the qualified call name for both JVM grammars.
 *
 * Java `method_invocation` exposes `object` / `name` fields, so we keep the
 * qualifier ("userService.searchUsers", not just "searchUsers").
 *
 * Kotlin `call_expression` has NEITHER field — the callee is the first child:
 * a `navigation_expression` (`this.service.getGlobalVariables`) for a qualified
 * call, or a `simple_identifier` (`bar`) for an unqualified one. Without this,
 * every Kotlin `receiver.method()` call resolved to null → the call graph saw
 * only same-scope `foo()` calls and missed all cross-object edges
 * (controller→service→dao), so traces never reached the data layer.
 */
function resolveJvmCallName(node: Node): string | null {
  if (node.type === "method_invocation") {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }
  if (node.type === "call_expression") {
    const callee = node.child(0);
    if (callee && (callee.type === "navigation_expression" || callee.type === "simple_identifier")) {
      // Collapse whitespace so a multiline fluent chain yields a clean dotted name.
      return callee.text.replace(/\s+/g, "");
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
