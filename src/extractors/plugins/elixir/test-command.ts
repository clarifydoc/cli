import type { TestTarget } from "../../../types/language-plugin.js";

/**
 * `mix test test/club_test.exs:12 test/club_test.exs:30`: the file, run only at the lines of its tests
 * and groups — whole when none is marked, or a hook or the file's own statements reach the change.
 */
export function elixirTestCommand(tests: readonly TestTarget[]): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const args: string[] = [];
  for (const file of files) {
    const lines: number[] = [];
    let whole = false;
    for (const t of tests.filter((x) => x.file === file)) {
      const cases = t.cases ?? [];
      if (!t.names?.length || t.names.includes("<setup>") || cases.some((c) => c.hook) || cases.length < t.names.length) whole = true;
      lines.push(...cases.map((c) => c.line));
    }
    if (whole || !lines.length) args.push(file);
    else args.push(...[...new Set(lines)].sort((a, b) => a - b).map((l) => `${file}:${l}`));
  }
  return `mix test ${args.join(" ")}`;
}
