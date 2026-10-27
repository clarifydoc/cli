import type { DeclaredPackage, PackageManagerSpec, SelfNameContext } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/**
 * NuGet: `<PackageReference>` in project files, `<PackageVersion>` in a
 * `Directory.Packages.props`, `<package>` in `packages.config`.
 */
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
  // Central Package Management (`Directory.Packages.props`): the version every
  // project's version-less `<PackageReference Include="X" />` resolves to.
  const cpm = /<PackageVersion\s+(?:Include|Update)\s*=\s*"([^"]+)"[^>]*?\bVersion\s*=\s*"([^"]+)"/gi;
  while ((m = cpm.exec(text)) !== null) {
    out.push(declared(m[1]!, m[2]!, "nuget", "prod", declaredIn));
  }
  // packages.config: <package id="X" version="Y" />
  const pc = /<package\s+id\s*=\s*"([^"]+)"(?:[^>]*?version\s*=\s*"([^"]+)")?/gi;
  while ((m = pc.exec(text)) !== null) {
    out.push(declared(m[1]!, m[2] ?? null, "nuget", "prod", declaredIn));
  }
  return out;
}

/**
 * The package a .NET project file publishes: its `<PackageId>`, else its
 * `<AssemblyName>`, else the file's own name — what `dotnet pack` calls it.
 * None for a file that is no project (`Directory.Packages.props`,
 * `packages.config`), one marked `<IsPackable>false</IsPackable>`, or a test
 * project (the test SDK makes it unpackable). A `$(…)` value names nothing.
 */
export function projectFileSelfName(text: string, file: SelfNameContext): string | null {
  const stem = /^(.+)\.(?:cs|fs|vb)proj$/i.exec(file.fileName)?.[1];
  if (!stem) return null;
  const property = (name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`, "i").exec(text)?.[1];
  if (/^false$/i.test(property("IsPackable") ?? "") || /<PackageReference\s+Include\s*=\s*"Microsoft\.NET\.Test\.Sdk"/i.test(text)) return null;
  const name = property("PackageId") ?? property("AssemblyName") ?? stem;
  return name.includes("$(") ? null : name;
}

export const nugetPackageManager: PackageManagerSpec = {
  ecosystem: "nuget",
  manifests: [
    {
      // Every .NET project format writes `<PackageReference>` the same way.
      files: ["**/*.csproj", "**/*.fsproj", "**/*.vbproj", "**/Directory.Packages.props", "**/packages.config"],
      glob: { deep: 3, limit: 50 },
      parse: (text, file) => parseCsproj(text, file.declaredIn),
      selfName: projectFileSelfName,
    },
  ],
  // The full namespace (`Microsoft.EntityFrameworkCore.Metadata`): it extends
  // the package id, or the id extends it (`Microsoft.Extensions.Http`).
  importKey: (s) => s.toLowerCase(),
  prefixMatch: { separator: ".", bidirectional: true },
};
