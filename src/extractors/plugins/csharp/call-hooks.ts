import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { csharpReceiverTypeOf } from "./local-types.js";
import { csharpArgOriginsOf } from "./arg-origins.js";

/**
 * `Foo x = new();` — a target-typed construction names its class only in the
 * declaration it initializes (local or field). Anywhere else (an argument, a
 * `return`) the type would need inference: no call.
 */
function implicitCreationName(node: Node): string | null {
  const declarator = node.parent;
  if (declarator?.type !== "variable_declarator") return null;
  const type = declarator.parent?.type === "variable_declaration" ? declarator.parent.childForFieldName("type") : null;
  if (!type || type.type === "implicit_type") return null;
  return `new ${type.text}`;
}

export const csharpCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["invocation_expression", "object_creation_expression", "implicit_object_creation_expression"]),
  nestedScopeTypes: ["local_function_statement", "anonymous_method_expression", "lambda_expression"],
  // A lambda passed as an argument (a LINQ predicate, a DI factory
  // `sp => new Foo(..)`, a `Task.Run(() => …)`, an event handler) runs on
  // behalf of the member that wires it — its calls are that member's. One
  // bound to a name (`Func<int> f = () => …`) stays a scope of its own.
  anonymousScopeTypes: ["lambda_expression", "anonymous_method_expression"],

  resolveCallName: (node) => genericResolveCallName(node, {
    extraCallee(callee, call) {
      if (callee.type === "identifier_name") return callee.text;
      // member_access_expression is already covered generically; kept for parity
      if (callee.type === "member_access_expression") return callee.text;
      // `_maybe?.Maybe()` → `_maybe?.Maybe` (core normalizes the `?`). An
      // element access (`a?[0]()`) is not a member call.
      if (callee.type === "conditional_access_expression") {
        const last = callee.namedChild(callee.namedChildCount - 1);
        return last?.type === "member_binding_expression" ? callee.text : null;
      }
      if (call.type === "implicit_object_creation_expression") return implicitCreationName(call);
      return null;
    },
  }),

  // `sp.GetRequiredService<IPricing>().Quote(o)` → receiver typed IPricing.
  receiverTypeOf: csharpReceiverTypeOf,
  argCountOf: csharpArgCount,
  argsOf: csharpTableArgs,
  // Where each argument comes from: a parameter, a request value, a literal (named arguments by name).
  argOriginsOf: csharpArgOriginsOf,
};

/**
 * The table an EF fluent `ToTable("league_clubs")` names — the one call whose
 * arguments a project pass reads (`reconcileProject` maps the entity the
 * enclosing `Entity<T>(…)` or `IEntityTypeConfiguration<T>` configures to it).
 */
function csharpTableArgs(node: Node): string[] | null {
  if (node.type !== "invocation_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_access_expression" || fn.childForFieldName("name")?.text !== "ToTable") return null;
  const first = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "argument")?.namedChildren[0];
  return first?.type === "string_literal" ? [first.text] : null;
}

/** A C# call's argument count: the `argument_list`'s arguments (named ones included). */
function csharpArgCount(node: Node): number | null {
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  return args.namedChildren.filter((c) => c.type === "argument").length;
}
