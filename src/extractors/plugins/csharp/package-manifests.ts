import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** NuGet: `<PackageReference>` in project files / `Directory.Packages.props`, `<package>` in `packages.config`. */
function parseCsproj(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // <PackageReference Include="X" Version="Y" /> (Version may also be a child element or absent under CPM).
  const re = /<PackageReference\s+(?:Include|Update)\s*=\s*"([^"]+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    const attrs = m[2] ?? "";
    const body = m[3] ?? "";
    const vAttr = attrs.match(/Version\s*=\s*"([^"]+)"/i);
    const vChild = body.match(/<Version>\s*([^<]+?)\s*<\/Version>/i);
    out.push(declared(name, vAttr?.[1] ?? vChild?.[1] ?? null, "nuget", "prod", declaredIn));
  }
  // packages.config: <package id="X" version="Y" />
  const pc = /<package\s+id\s*=\s*"([^"]+)"(?:[^>]*?version\s*=\s*"([^"]+)")?/gi;
  while ((m = pc.exec(text)) !== null) {
    out.push(declared(m[1]!, m[2] ?? null, "nuget", "prod", declaredIn));
  }
  return out;
}

export const nugetPackageManager: PackageManagerSpec = {
  ecosystem: "nuget",
  manifests: [
    {
      files: ["**/*.csproj", "**/Directory.Packages.props", "**/packages.config"],
      glob: { deep: 3, limit: 50 },
      parse: (text, file) => parseCsproj(text, file.declaredIn),
    },
  ],
  // The full namespace (`Microsoft.EntityFrameworkCore.Metadata`): it extends
  // the package id, or the id extends it (`Microsoft.Extensions.Http`).
  importKey: (s) => s.toLowerCase(),
  prefixMatch: { separator: ".", bidirectional: true },
};
