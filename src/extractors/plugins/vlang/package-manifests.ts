import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/**
 * VPM: the `dependencies: ['markdown', 'nedpals.vex', 'https://github.com/u/x']`
 * list of a `v.mod`. A URL names the module after its last segment.
 */
function parseVMod(text: string, declaredIn: string): DeclaredPackage[] {
  const list = /\bdependencies\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  if (!list) return [];
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const m of list.matchAll(/(['"])([^'"]+)\1/g)) {
    const name = m[2]!.trim().replace(/\.git$/, "").replace(/^.*\//, "");
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(declared(name, null, "vpm", "prod", declaredIn));
  }
  return out;
}

export const vpmPackageManager: PackageManagerSpec = {
  ecosystem: "vpm",
  manifests: [{ files: ["v.mod"], parse: (text, file) => parseVMod(text, file.declaredIn) }],
  // `import nedpals.vex.router` reaches the `nedpals.vex` package; `import
  // markdown` the `markdown` one. Standard modules are declared nowhere.
  importKey: (source) => source.toLowerCase(),
  prefixMatch: { separator: "." },
};
