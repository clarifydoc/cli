import { conventionReachability } from "../shared/reachability-kit.js";
import type { ReachabilityModel } from "../../../types/language-plugin.js";

/**
 * Zig dead-code model. `@import("db.zig")` names a file beside the importer
 * (a package is `@import("zap")`, never a file of this project), and what is
 * compiled at all is what `build.zig` hands the compiler: every `.zig` path it
 * names (`b.path("src/main.zig")`, a module's `root_source_file`) is a root. So
 * is a file with `pub fn main` or a C ABI `export fn`, and a package's
 * conventional root (`src/root.zig`). `build.zig` itself is run by the
 * toolchain; a test file by `zig build test` / `zig test`.
 */
export const zigReachability = conventionReachability({
  extensions: [".zig"],
  importPath: (source) => (/\.zig$/.test(source) ? source : null),
  mainFunctions: /^main$/,
  entrySource: [
    [/^\s*pub\s+fn\s+main\s*\(/m, "program entry (`pub fn main`)"],
    [/^\s*export\s+fn\s/m, "C ABI export (`export fn`)"],
  ],
  entryFiles: [[/^src\/(?:root|lib|main)\.zig$/, "package root"]],
  passiveFiles: [
    [/(?:^|\/)build\.zig$/, "build script"],
    [/(?:^|\/)tests?\//, "test (run by `zig build test`)"],
  ],
  async extend(_ctx, kit, base) {
    const named = new Set<string>();
    for (const rel of await kit.listFiles()) {
      if (!/(?:^|\/)build\.zig$/.test(rel)) continue;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
      const text = (await kit.readText(rel)) ?? "";
      for (const m of text.matchAll(/"([^"\n]+\.zig)"/g)) named.add(normalize(dir + m[1]!.replace(/^\.\//, "")));
    }
    if (named.size === 0) return {};
    const entryReason: ReachabilityModel["entryReason"] = (analysis, relPath, frameworks, readSource) =>
      base.entryReason?.(analysis, relPath, frameworks, readSource) ?? (named.has(analysis.filePath) ? "named in build.zig" : null);
    return { entryReason };
  },
});

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}
