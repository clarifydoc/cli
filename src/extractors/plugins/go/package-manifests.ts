import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Go modules: `go.mod` `require` lines and blocks. */
function parseGoMod(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // require ( <path> <version> [// indirect] ) blocks and single-line requires.
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("require (")) { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    let body = line;
    if (!inBlock) {
      const single = line.match(/^require\s+(.+)$/);
      if (!single) continue;
      body = single[1]!;
    }
    if (!body || body.startsWith("//")) continue;
    const parts = body.replace(/\/\/.*$/, "").trim().split(/\s+/);
    if (parts.length < 2) continue;
    out.push(declared(parts[0]!, parts[1]!, "go", "prod", declaredIn));
  }
  return out;
}

export const goPackageManager: PackageManagerSpec = {
  ecosystem: "go",
  manifests: [{
    files: ["go.mod"],
    parse: (text, file) => parseGoMod(text, file.declaredIn),
    selfName: (text) => /^module\s+(\S+)/m.exec(text)?.[1] ?? null,
  }],
  // The full import path: the module path is it, or an ancestor of it.
  importKey: (s) => (s.startsWith(".") ? null : s.toLowerCase()),
  prefixMatch: { separator: "/" },
  assertsUnused: true,
};
