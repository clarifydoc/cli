import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * `swift test --filter <Target>.<Class>/<method>`: SwiftPM takes several regex filters (any may match). The
 * target is the one a manifest's `.testTarget(path:)` gives the file's directory (`TestCommandContext.testTargets`),
 * else the directory under `Tests/` the file sits in; a test reached only through a helper is run as its
 * class, each filter anchored so a namesake prefix is not run, and a file outside a `Tests/<Target>` folder runs the whole suite.
 */
export function swiftTestCommand(tests: readonly TestTarget[], ctx?: TestCommandContext): string | null {
  if (!tests.length) return null;
  const filters = new Set<string>();
  for (const t of tests) {
    // A target the manifest gave its own directory (`path: "Tests/Custom"`) owns the files below it, the deepest first.
    const declared = (ctx?.testTargets ?? []).filter((x) => t.file.startsWith(`${x.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]?.name;
    const target = declared ?? /(?:^|\/)Tests\/([A-Za-z_]\w*)\//.exec(t.file)?.[1];
    if (!target) return "swift test";
    const named = t.names.filter((n) => /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(n));
    const methods = named.filter((n) => /\.test/.test(n));
    if (methods.length) for (const n of methods) filters.add(`^${target}\\.${n.replace(".", "/")}$`);
    else if (named.length) for (const n of named) filters.add(`^${target}\\.${n.split(".")[0]}/`);
    else filters.add(`^${target}\\.`);
  }
  return `swift test ${[...filters].sort().map((f) => `--filter '${f}'`).join(" ")}`;
}
