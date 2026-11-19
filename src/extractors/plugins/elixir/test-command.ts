import type { TestTarget } from "../../../types/language-plugin.js";

/** The umbrella app a test file belongs to: `apps/club` for `apps/club/test/club_test.exs` (`""` for any other file). */
function umbrellaApp(file: string): string {
  return /^((?:.*?\/)?apps\/[^/]+)\/test\//.exec(file)?.[1] ?? "";
}

/**
 * `mix test test/club_test.exs:12 test/club_test.exs:30`: the file, run only at the lines of its tests
 * and groups — whole when none is marked, or a hook or the file's own statements reach the change.
 * A test under an umbrella's `apps/<app>/test/` runs inside that app — `(cd apps/club && mix test test/club_test.exs)`,
 * its path made relative to it: from the umbrella root `mix test` recurses into every app and hands each the paths
 * (an app whose test paths do not hold one has nothing to run for it), so the plain form works only as far as
 * mix's recursion goes; `cd` into the app is the one form every mix version takes, and unlike `mix cmd --app club mix
 * test …` needs no second quoting. One command per app, the root's own tests first. Not executed here (no mix).
 */
export function elixirTestCommand(tests: readonly TestTarget[]): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const byApp = new Map<string, string[]>();
  for (const file of files) {
    const app = umbrellaApp(file);
    const lines: number[] = [];
    let whole = false;
    for (const t of tests.filter((x) => x.file === file)) {
      const cases = t.cases ?? [];
      if (!t.names?.length || t.names.includes("<setup>") || cases.some((c) => c.hook) || cases.length < t.names.length) whole = true;
      lines.push(...cases.map((c) => c.line));
    }
    const path = app ? file.slice(app.length + 1) : file;
    const args = byApp.get(app) ?? byApp.set(app, []).get(app)!;
    if (whole || !lines.length) args.push(path);
    else args.push(...[...new Set(lines)].sort((a, b) => a - b).map((l) => `${path}:${l}`));
  }
  return [...byApp]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([app, args]) => (app ? `(cd ${app} && mix test ${args.join(" ")})` : `mix test ${args.join(" ")}`))
    .join(" && ");
}
