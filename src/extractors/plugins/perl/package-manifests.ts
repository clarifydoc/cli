import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** CPAN: `requires` / `recommends` / `suggests` lines of a `cpanfile`. */
function parseCpanfile(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const re = /^\s*(?:requires|recommends|suggests)\s+['"]([^'"]+)['"]\s*(?:,\s*['"]?([0-9._]+)['"]?)?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(declared(m[1]!, m[2] ?? null, "cpan", "prod", declaredIn));
  return out;
}

export const cpanPackageManager: PackageManagerSpec = {
  ecosystem: "cpan",
  manifests: [{ files: ["cpanfile"], parse: (text, file) => parseCpanfile(text, file.declaredIn) }],
  // The full module (`Foo::Bar::Baz`): it extends the distribution's top
  // module, or that extends it.
  importKey: (s) => s.toLowerCase(),
  prefixMatch: { separator: "::", bidirectional: true },
};
