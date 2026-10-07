import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { commandName, SHELL_BUILTINS } from "./commands.js";

/**
 * A shell call is a `command` node: `deploy "$env"`, `curl …`, `psql …`. A
 * path (`./scripts/build.sh`) is a script RUN, recorded as an import
 * (imports.ts), and builtins call nothing of the project's.
 */
export const bashCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["command"]),
  nestedScopeTypes: ["function_definition"],
  resolveCallName(node) {
    const name = commandName(node);
    if (!name || name.includes("/") || SHELL_BUILTINS.has(name)) return null;
    return name;
  },
};
