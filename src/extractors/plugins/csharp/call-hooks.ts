import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

export const csharpCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["invocation_expression", "object_creation_expression"]),
  nestedScopeTypes: ["local_function_statement", "anonymous_method_expression", "lambda_expression"],

  resolveCallName: (node) => genericResolveCallName(node, {
    extraCallee(callee) {
      if (callee.type === "identifier_name") return callee.text;
      // member_access_expression is already covered generically; kept for parity
      if (callee.type === "member_access_expression") return callee.text;
      return null;
    },
  }),
};
