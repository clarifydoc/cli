import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Hackage: every `build-depends:` block of a `.cabal` file (continuation lines included). */
function parseCabal(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  // `build-depends: base >=4.7 && <5, text, aeson >= 1.5` — possibly multi-line
  // (continuation lines are indented). Collect from each build-depends block.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*build-depends\s*:(.*)$/i);
    if (!m) continue;
    let block = m[1]!;
    for (let j = i + 1; j < lines.length; j++) {
      // Continuation: an indented line that isn't a new `field:` declaration.
      if (/^\s+\S/.test(lines[j]!) && !/^\s*[A-Za-z-]+\s*:/.test(lines[j]!)) block += " " + lines[j];
      else break;
    }
    for (const part of block.split(",")) {
      const name = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (name && !seen.has(name)) { seen.add(name); out.push(declared(name, null, "hackage", "prod", declaredIn)); }
    }
  }
  return out;
}

export const hackagePackageManager: PackageManagerSpec = {
  ecosystem: "hackage",
  manifests: [
    { files: ["*.cabal", "**/*.cabal"], glob: { deep: 2, limit: 10 }, parse: (text, file) => parseCabal(text, file.declaredIn) },
  ],
  // `import Data.Aeson` / `Web.Scotty` / `Network.Wai.Handler.Warp` → the LAST
  // module segment ≈ the package (aeson, scotty, warp). The few that differ
  // (Data.Map → containers) only miss: usage is positive-only.
  importKey(s) {
    const parts = s.split(".");
    return parts[parts.length - 1]!.toLowerCase();
  },
};
