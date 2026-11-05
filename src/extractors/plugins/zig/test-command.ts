import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/**
 * Zig tests live in the source files that declare them. A project with a package manifest is run
 * through its build (`zig build test` — a build script names which files it tests, and a filter is
 * its own option); without one, each file by itself with a name filter, which Zig matches as a
 * substring of the test's name (`test "ranks clubs"` → `ranks clubs`; a doctest by its declaration).
 */
export function zigTestCommand(tests: readonly TestTarget[], ctx?: TestCommandContext): string | null {
  if (!tests.length) return null;
  if (ctx?.manifests.has("build.zig.zon")) return "zig build test";
  const lines = [...new Set(tests.map((t) => t.file))].sort().map((file) => {
    const target = tests.find((t) => t.file === file)!;
    const titles = target.cases?.length
      ? target.cases.filter((c) => !c.hook).map((c) => c.path[c.path.length - 1] ?? "")
      : [];
    const filters = [...new Set(titles.filter((n) => n && !/^test at line \d+$/.test(n)).map((n) => n.replace(/^test /, "")))].sort();
    const quoted = filters.length === 1 ? ` --test-filter "${filters[0]!.replace(/(["\\$`])/g, "\\$1")}"` : "";
    return `zig test ${file}${quoted}`;
  });
  return lines.join(" && ");
}
