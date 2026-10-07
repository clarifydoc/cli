import { conventionReachability, withPassive } from "../shared/reachability-kit.js";

/** Directories of programs and checks a person or a tool runs, not the program itself. */
const TOOL_DIRS = /(?:^|\/)(?:tests?|examples?|benchmarks?|bench)\//;

/**
 * Nim dead-code model. `import x/y` / `include x` name `x/y.nim` beside the
 * importer or under a source root (`std/…` and `pkg/…` are the toolchain's).
 * Any module can be compiled as the main one: a program starts at a `when
 * isMainModule:` block, a Jester `routes:` block (it generates the server's
 * main), a top-level `app.run()` (Prologue) or `runForever()`, and at the
 * files a `.nimble` names (`bin`, task commands). Tests, examples, scripts
 * and NimScript files are run by a tool or a person — alive, never reported,
 * anchoring nothing. A package whose `.nimble` builds no `bin` is a library:
 * its modules are its API.
 */
export const nimReachability = conventionReachability({
  extensions: [".nim", ".nims"],
  importPath: (source) => (/^(?:std|pkg|system)(?:\/|$)/.test(source) ? null : /^[\w./-]+$/.test(source) ? source : null),
  names: { stem: true },
  entrySource: [
    [/^\s*when\s+isMainModule\b/m, "program entry (when isMainModule)"],
    [/^routes\s*:/m, "Jester application (routes:)"],
    [/^(?:[A-Za-z_]\w*\.run\s*\(|runForever\s*\()/m, "program entry (top-level run)"],
  ],
  passiveFiles: [
    [/\.nims$/, "NimScript configuration"],
    [TOOL_DIRS, "test, example or benchmark program"],
  ],
  // A module that runs statements at its top level (`echo …`, `main()`,
  // `block:`) is a script someone compiles and runs — a data importer, a
  // setup tool — even when nothing names it.
  passiveSource: [
    [
      /^(?:(?:block|for|while|if|try|discard|waitFor)\b|(?!(?:proc|func|method|iterator|converter|template|macro|type|const|let|var|import|from|include|export|when|using|mixin|bind|static|elif|else|of|except|finally|case|return|yield|break|continue|raise)\b)[A-Za-z_][\w.]*(?:\(|[ \t]+(?!=)["'\w@\[(-]))/m,
      "Nim script (statements at the top level)",
    ],
  ],
  configFiles: /(?:^|\/)[^/]+\.nimble$/,
  async extend(_ctx, kit, base) {
    // Libraries: a `.nimble` with no `bin` publishes its source directory.
    const libraryRoots: string[] = [];
    for (const rel of await kit.listFiles()) {
      if (!rel.endsWith(".nimble")) continue;
      const text = (await kit.readText(rel)) ?? "";
      if (/^\s*(?:bin|namedBin)\s*=/m.test(text)) continue;
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const src = /^\s*srcDir\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? "";
      libraryRoots.push([dir, src].filter(Boolean).join("/"));
    }
    return {
      // A test or an example is run by a tool even when it is its own main.
      entryReason: (analysis, relPath, frameworks, readSource) =>
        TOOL_DIRS.test(analysis.filePath) ? null : base.entryReason(analysis, relPath, frameworks, readSource),
      ...withPassive(base, (analysis) =>
        libraryRoots.some((r) => r === "" || analysis.filePath.startsWith(r + "/")) ? "nimble library module (public API)" : null,
      ),
    };
  },
});
