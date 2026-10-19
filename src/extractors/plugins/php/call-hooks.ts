import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { phpLocatorType } from "./di.js";

/** Strip PHP's `$` sigil and convert `->` chain separators to `.` so qualified
 *  names look like `this.repo.find` instead of `$this->repo->find`. */
function normalizePhpReceiver(text: string): string {
  return text.replace(/\$/g, "").replace(/\??->/g, ".");
}

export const phpCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set([
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
    "object_creation_expression",
  ]),
  nestedScopeTypes: [
    "method_declaration", "function_definition", "class_declaration",
    "interface_declaration", "trait_declaration",
    // tree-sitter-php ≥0.23 names closures `anonymous_function`; the long
    // form is the pre-rename name, kept for older grammars.
    "anonymous_function", "anonymous_function_creation_expression", "arrow_function",
  ],
  // A closure passed along (`->map(fn ($u) => $this->repo->find($u))`, a
  // container factory) runs on behalf of the method that wires it: its calls
  // are attributed there, as JS does for inline callbacks.
  anonymousScopeTypes: ["anonymous_function", "anonymous_function_creation_expression", "arrow_function"],

  // PHP call shapes. We normalize `$this->prop->method` chains into the
  // dotted form `this.prop.method` so the symbol-linker's injection/property
  // tracking (which keys on `this.<name>`) can match it.
  resolveCallName: (node) => genericResolveCallName(node, {
    extraCallee(callee, n) {
      // An unqualified `helper()` is a bare `name` node — not an identifier.
      if (n.type === "function_call_expression" && callee.type === "name") return callee.text;
      // `new Report()` names its class in an unlabelled child.
      if (n.type === "object_creation_expression") {
        const cls = n.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
        return cls ? `new ${cls.text}` : null;
      }
      if (n.type === "member_call_expression" || n.type === "nullsafe_member_call_expression") {
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

  // `app(Mailer::class)->send()`, `$container->get(Mailer::class)->send()`,
  // `(new Mailer)->send()`: the receiver expression names its own type.
  receiverTypeOf(node) {
    if (node.type !== "member_call_expression" && node.type !== "nullsafe_member_call_expression") return null;
    const obj = node.childForFieldName("object");
    if (
      !obj ||
      (obj.type !== "function_call_expression" &&
        obj.type !== "member_call_expression" &&
        obj.type !== "scoped_call_expression" &&
        obj.type !== "parenthesized_expression")
    ) {
      return null;
    }
    const looked = phpLocatorType(obj);
    if (!looked) return null;
    return looked.qualifier ? { type: looked.type, qualifier: looked.qualifier } : { type: looked.type };
  },
};
