import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/**
 * Nimble: every `requires` of a `.nimble` file — `requires "jester >= 0.5.0"`,
 * `requires "a", "b#head"`, `requires("x")`, a URL (`https://github.com/u/pkg`
 * names `pkg`) — in `when` branches and `feature` blocks too. `nim` itself is
 * the compiler, not a package.
 */
function parseNimble(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\s*requires\b\s*\(?([^\n]*)/gm)) {
    // A `#` inside the quotes pins a commit (`"jester#405be2e"`); outside, it opens a comment.
    const args = m[1]!.replace(/("[^"]*")|#.*$/g, (_all, quoted: string | undefined) => quoted ?? "");
    for (const spec of args.matchAll(/"([^"]+)"/g)) {
      const dep = /^\s*([^\s<>=~^#@]+)\s*(.*)$/.exec(spec[1]!);
      if (!dep) continue;
      const name = dep[1]!.replace(/\.git$/, "").replace(/^.*\//, "");
      if (!name || name.toLowerCase() === "nim" || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const version = /[<>=~^]=?\s*([\w.+-]+)/.exec(dep[2]!)?.[1] ?? /#(\S+)/.exec(spec[1]!)?.[1] ?? null;
      out.push(declared(name, version, "nimble", "prod", declaredIn));
    }
  }
  return out;
}

export const nimblePackageManager: PackageManagerSpec = {
  ecosystem: "nimble",
  manifests: [{ files: ["*.nimble", "**/*.nimble"], glob: { deep: 2, limit: 10 }, parse: (text, file) => parseNimble(text, file.declaredIn) }],
  // `import jester`, `import pkg/jester/x`, `from prologue/core import y` → the
  // first segment names the package; `std/…`, `./…` and the system module do not.
  importKey(source) {
    if (/^\.{1,2}\//.test(source) || /^(?:std|system)(?:\/|$)/.test(source)) return null;
    const first = source.replace(/^pkg\//, "").split("/")[0]!;
    return /^[A-Za-z_]\w*$/.test(first) ? first.toLowerCase() : null;
  },
};
