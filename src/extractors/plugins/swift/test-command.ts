import type { TestTarget } from "../../../types/language-plugin.js";

/**
 * `swift test --filter <Target>.<Class>/<method>`: SwiftPM takes several regex filters (any may match). The
 * target is the directory under `Tests/` the file sits in; a test reached only through a helper is run as its
 * class, each filter anchored so a namesake prefix is not run, and a file outside a `Tests/<Target>` folder runs the whole suite.
 */
export function swiftTestCommand(tests: readonly TestTarget[]): string | null {
  if (!tests.length) return null;
  const filters = new Set<string>();
  for (const t of tests) {
    const target = /(?:^|\/)Tests\/([A-Za-z_]\w*)\//.exec(t.file)?.[1];
    if (!target) return "swift test";
    const named = t.names.filter((n) => /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(n));
    const methods = named.filter((n) => /\.test/.test(n));
    if (methods.length) for (const n of methods) filters.add(`^${target}\\.${n.replace(".", "/")}$`);
    else if (named.length) for (const n of named) filters.add(`^${target}\\.${n.split(".")[0]}/`);
    else filters.add(`^${target}\\.`);
  }
  return `swift test ${[...filters].sort().map((f) => `--filter '${f}'`).join(" ")}`;
}
