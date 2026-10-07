import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Paket: `nuget Giraffe ~> 6.0` lines of `paket.dependencies` (NuGet packages). */
function parsePaket(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  for (const m of text.matchAll(/^\s*nuget\s+([A-Za-z][\w.-]*)(?:\s+([^\s/][^\r\n]*?))?\s*$/gm)) {
    out.push(declared(m[1]!, m[2]?.trim() || null, "nuget", "prod", declaredIn));
  }
  return out;
}

/** Paket resolves from NuGet: its packages join C#'s `nuget` ecosystem, matched there. */
export const paketPackageManager: PackageManagerSpec = {
  ecosystem: "nuget",
  manifests: [{ files: ["paket.dependencies"], parse: (text, file) => parsePaket(text, file.declaredIn) }],
};
