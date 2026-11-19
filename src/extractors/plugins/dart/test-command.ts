import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * `flutter test` for a project that depends on Flutter, else `dart test`, on the test files. A name filter
 * is added only when exactly one marked test reaches the change in a single file: the runner ANDs repeated
 * `--plain-name` filters, so two tests could never be named in one run, and the filter applies to every
 * file listed. The name is the test's group titles and its own, joined by spaces as the runner reads them.
 */
export function dartTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const runner = ctx.packages.has("flutter") || ctx.packages.has("flutter_test") ? "flutter test" : "dart test";
  const cases = tests.flatMap((t) => (t.cases ?? []).filter((c) => !c.hook));
  const everyMarked = tests.every((t) => t.names.length > 0 && !t.names.includes("<setup>") && !t.cases?.some((c) => c.hook) && (t.cases?.length ?? 0) === t.names.length);
  if (files.length === 1 && cases.length === 1 && everyMarked) {
    return `${runner} ${files[0]} --plain-name '${cases[0]!.path.join(" ").replace(/'/g, `'\\''`)}'`;
  }
  return `${runner} ${files.join(" ")}`;
}
