import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { calleeName, isShortFunction } from "./syntax.js";

/** Calls that are Julia's loading and plumbing rather than code to link. */
const LANGUAGE_CALLS = new Set(["include", "error", "throw", "println", "print", "string", "length", "isnothing", "push!", "get", "haskey", "getfield", "setfield!", "convert", "typeof", "eltype", "collect", "map", "filter", "foreach", "something", "nothing"]);

/**
 * A Julia call is a `call_expression` (`f(x)`, `HTTP.get(url)`); a
 * definition's own signature (`function f(x)` / `f(x) = …`) is none. A
 * `do` block and an anonymous `function (x) … end` belong to the enclosing
 * function. A short-form function (`f(x) = …`) ends the module-level walk.
 */
export const juliaCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression"]),
  // A `do` block is a closure: inside a function its calls are the function's,
  // but at module level it runs later (a Genie route), never at load.
  nestedScopeTypes: ["function_definition", "macro_definition", "do_clause"],
  anonymousScopeTypes: ["function_definition", "do_clause"],
  isFunctionDefinition: isShortFunction,
  resolveCallName(node) {
    let p = node.parent;
    while (p && (p.type === "typed_expression" || p.type === "where_expression")) p = p.parent;
    if (p?.type === "signature") return null;
    if (p?.type === "assignment" && isShortFunction(p) && p.namedChildren[0]!.startIndex <= node.startIndex && node.endIndex <= p.namedChildren[0]!.endIndex) return null;
    const name = calleeName(node.namedChildren[0]);
    return name && !LANGUAGE_CALLS.has(name) ? name : null;
  },
};
