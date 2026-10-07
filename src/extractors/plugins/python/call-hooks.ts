import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { pythonReceiverTypeOf } from "./di.js";

export const pythonCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call"]),
  nestedScopeTypes: ["function_definition", "class_definition", "lambda"],
  callbackArgNodeTypes: ["call"],
  // A name the function binds itself is a value when passed as an argument,
  // not a callback reference (see CallExtractionHooks.bindingSites).
  bindingSites: {
    function_definition: ["parameters"],
    lambda: ["parameters"],
    assignment: ["left"],
    augmented_assignment: ["left"],
    for_statement: ["left"],
    for_in_clause: ["left"],
    named_expression: ["name"],
    as_pattern: ["alias"], // with … as f, except E as e
  },
  bindingPatterns: {
    parameters: ["*"],
    lambda_parameters: ["*"],
    typed_parameter: ["*"], // the annotation's node is `type`, which binds nothing
    default_parameter: ["name"],
    typed_default_parameter: ["name"],
    list_splat_pattern: ["*"],
    dictionary_splat_pattern: ["*"],
    pattern_list: ["*"],
    tuple_pattern: ["*"],
    list_pattern: ["*"],
    as_pattern_target: ["*"],
    tuple: ["*"], // `as (u, v)` parses its target as a tuple expression
  },

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

  // `injector.get(UserRepo).find()`, `container.repo().find()` — a container
  // lookup chained straight into the call types its receiver (see di.ts).
  receiverTypeOf: pythonReceiverTypeOf,
};
