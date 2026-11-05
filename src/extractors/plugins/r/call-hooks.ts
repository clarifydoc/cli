import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { callName } from "./syntax.js";

/** Calls that are R's syntax rather than code to link: `function`, `list(…)`, `c(…)`, … */
const LANGUAGE_CALLS = new Set(["c", "list", "function", "return", "invisible", "library", "require", "requireNamespace", "source", "stop", "warning", "message", "print", "cat", "paste", "paste0", "is.null", "length", "names", "vapply", "sapply", "lapply", "Map", "Reduce", "Filter", "do.call", "missing", "match.arg", "stopifnot", "tryCatch", "on.exit", "sprintf", "format", "nchar"]);

/**
 * An R call is a `call` node: `f(x)`, `pkg::f(x)` (`pkg.f`), `obj$method()`
 * (`obj.method`) — R6's `self$repo$find()` reads as `self.repo.find`. A
 * function defined inside another (a callback, a local helper) is anonymous
 * to the walk, so its calls belong to the enclosing function.
 */
export const rCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call"]),
  nestedScopeTypes: ["function_definition"],
  anonymousScopeTypes: ["function_definition"],
  resolveCallName(node) {
    const name = callName(node);
    if (!name || LANGUAGE_CALLS.has(name)) return null;
    // R6's `private$warmup()` is the class's own member, as `self$warmup()` is.
    return name.startsWith("private.") ? `self.${name.slice("private.".length)}` : name;
  },
};
