import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * D's `unittest` blocks run with the module: `dub test` builds every source of a dub package with
 * `-unittest` and runs them (the language has no name filter, so the whole package); a file outside
 * any dub package is compiled and run by itself.
 */
export function dubTestCommand(tests: readonly TestTarget[], ctx?: TestCommandContext): string | null {
  if (!tests.length) return null;
  if (ctx?.manifests.has("dub.json") || ctx?.manifests.has("dub.sdl")) return "dub test";
  return [...new Set(tests.map((t) => t.file))].sort().map((file) => `dmd -unittest -main -run ${file}`).join(" && ");
}
