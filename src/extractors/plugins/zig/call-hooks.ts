import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { calleeName } from "./syntax.js";

/**
 * A Zig call is a `call_expression` (`foo(x)`, `repo.save(o)`,
 * `std.debug.print(…)`); a builtin (`@import`, `@intCast`) is a
 * `builtin_function` and calls nothing of the project. Zig has no closures:
 * a function or test block nested in a container is its own scope.
 */
export const zigCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression"]),
  nestedScopeTypes: ["function_declaration", "test_declaration"],
  resolveCallName(node) {
    return calleeName(node.childForFieldName("function"));
  },
};
