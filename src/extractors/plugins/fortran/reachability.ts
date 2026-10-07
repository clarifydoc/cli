import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/** Directories of programs a person or a tool runs to exercise the code, not the program itself. */
const TOOL_DIRS = /(?:^|\/)(?:tests?|examples?|benchmarks?|bench|demos?)\//i;
/** A module declaration (`module procedure` is a procedure body, not a module). */
const MODULE_DECLARATION = /^[ \t]*module[ \t]+(?!(?:procedure|function|subroutine)\b)([A-Za-z]\w*)/gim;

/**
 * Fortran dead-code model. `use solvers` names the module, which any file
 * may declare (module and file names often differ), so it resolves through
 * the modules the project's files declare; `include 'x.inc'` names a file.
 * Procedures are also called by name from files that `use` nothing (FORTRAN
 * 77 externals), so a file is reached when reachable code mentions what it
 * declares — in any letter case. A main `program` starts a program; programs
 * under tests or examples are run by a tool. An fpm package's library
 * sources are its API.
 */
export const fortranReachability = conventionReachability({
  extensions: [".f", ".for", ".f77", ".f90", ".f95", ".f03", ".f08", ".fpp"],
  caseInsensitive: true,
  importPath: (source) => (/[./]/.test(source) ? source : null),
  names: { functions: true, types: true, declaration: MODULE_DECLARATION },
  entrySource: [[/^[ \t]*program[ \t]+\w+/im, "main program"]],
  passiveFiles: [[TOOL_DIRS, "test, example or benchmark program"]],
  async extend(_ctx, kit, base) {
    const modules = new Map<string, string[]>();
    for (const f of kit.files) {
      for (const m of ((await kit.readText(f)) ?? "").matchAll(MODULE_DECLARATION)) {
        const key = m[1]!.toLowerCase();
        const list = modules.get(key) ?? modules.set(key, []).get(key)!;
        if (!list.includes(f)) list.push(f);
      }
    }
    // fpm: a `[library]` (default `src/`) is the package's API.
    const libraryDirs: string[] = [];
    for (const rel of await kit.listFiles()) {
      if (!/(?:^|\/)fpm\.toml$/.test(rel)) continue;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const text = (await kit.readText(rel)) ?? "";
      const src = /\[library\][^[]*?source-dir\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? "src";
      libraryDirs.push([dir, src].filter(Boolean).join("/"));
    }
    return {
      // A test or an example program is run by a tool, though it is a main program.
      entryReason: (analysis, relPath, frameworks, readSource) =>
        TOOL_DIRS.test(analysis.filePath) ? null : base.entryReason(analysis, relPath, frameworks, readSource),
      ...withPassive(base, (analysis) =>
        libraryDirs.some((d) => analysis.filePath.startsWith(d + "/")) ? "fpm library source (public API)" : null,
      ),
      resolve(fromFile: string, source: string): string[] | null {
        const declaring = modules.get(source.toLowerCase());
        return declaring ? declaring.filter((f) => f !== fromFile) : base.resolve(fromFile, source);
      },
      // Mentions are matched as written: offer each name in the casings code spells it in.
      declaredNames: (analysis, source) =>
        [...new Set((base.declaredNames?.(analysis, source) ?? []).flatMap((n) => [n, n.toLowerCase(), n.toUpperCase()]))],
    };
  },
});
