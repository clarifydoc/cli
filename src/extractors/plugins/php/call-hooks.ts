import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";

/** Strip PHP's `$` sigil and convert `->` chain separators to `.` so qualified
 *  names look like `this.repo.find` instead of `$this->repo->find`. */
function normalizePhpReceiver(text: string): string {
  return text.replace(/\$/g, "").replace(/->/g, ".");
}

export const phpCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set([
    "function_call_expression",
    "member_call_expression",
    "scoped_call_expression",
    "object_creation_expression",
  ]),
  nestedScopeTypes: [
    "method_declaration", "function_definition", "class_declaration",
    "interface_declaration", "trait_declaration",
    "anonymous_function_creation_expression", "arrow_function",
  ],

  // PHP call shapes. We normalize `$this->prop->method` chains into the
  // dotted form `this.prop.method` so the symbol-linker's injection/property
  // tracking (which keys on `this.<name>`) can match it.
  resolveCallName: (node) => genericResolveCallName(node, {
    extraCallee(_callee, n) {
      if (n.type === "member_call_expression") {
        const obj = n.childForFieldName("object");
        const name = n.childForFieldName("name");
        if (name) {
          return obj ? `${normalizePhpReceiver(obj.text)}.${name.text}` : name.text;
        }
      }
      if (n.type === "scoped_call_expression") {
        const scope = n.childForFieldName("scope");
        const name = n.childForFieldName("name");
        if (name) {
          return scope ? `${scope.text.replace(/\\/g, "")}.${name.text}` : name.text;
        }
      }
      return null;
    },
  }),
};
