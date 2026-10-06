import { conventionReachability } from "../shared/reachability-kit.js";

/**
 * Haskell dead-code model. `import Data.Foo` names `Data/Foo.hs` under a
 * source directory. Entries: `main`, `Main.hs`, `app/`, and the library's
 * library's `exposed-modules` (public API — alive, but no program starts
 * there) read from `*.cabal` / `package.yaml`.
 */
export const haskellReachability = conventionReachability({
  extensions: [".hs", ".lhs"],
  importPath: (source) => (/^[A-Z][\w.]*$/.test(source) ? source.replace(/\./g, "/") : null),
  names: { types: true, stem: true },
  mainFunctions: /^main$/,
  entryFiles: [
    [/(?:^|\/)(?:Main|Setup)\.l?hs$/, "program entry"],
    [/^app\//, "executable source"],
  ],
  async extend(_ctx, kit, base) {
    // `exposed-modules:` lists (cabal fields run until the next unindented
    // field; package.yaml lists are indented `- Module` lines).
    const exposed = new Set<string>();
    for (const rel of await kit.listFiles()) {
      if (!/\.cabal$|(?:^|\/)package\.yaml$/.test(rel)) continue;
      const text = (await kit.readText(rel)) ?? "";
      for (const m of text.matchAll(/exposed-modules\s*:([\s\S]*?)(?=\n\s*[A-Za-z-]+\s*:|\n\S|$)/gi)) {
        for (const mod of m[1]!.match(/[A-Z][\w.]*/g) ?? []) exposed.add(mod.split(".").pop()!);
      }
    }
    // Exposed modules are a library's API: alive, but they start nothing.
    return {
      passiveReason(analysis, relPath, frameworks, readSource) {
        const stem = analysis.filePath.replace(/^.*\//, "").replace(/\..*$/, "");
        return exposed.has(stem) ? "exposed module (library API)" : base.passiveReason?.(analysis, relPath, frameworks, readSource) ?? null;
      },
    };
  },
});
