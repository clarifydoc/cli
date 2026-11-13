import type { DeclaredPackage, PackageManagerSpec, ProjectReference, SelfNameContext } from "../../../types/language-plugin.js";
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

/** One `<Using …>` item in file order: `Include` adds (an alias is not a namespace import), `Remove` takes the name away. */
const MSBUILD_USING_RE = /<Using\s+((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/gi;

type UsingOp = { op: "add" | "remove"; name: string };

function usingOps(text: string): UsingOp[] {
  const out: UsingOp[] = [];
  for (const m of text.matchAll(MSBUILD_USING_RE)) {
    const attrs = m[1]!;
    const conditional = /\bCondition\s*=/i.test(attrs);
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)?.[1];
    const remove = attr("Remove");
    if (remove !== undefined) {
      // A conditional Remove may hold: counted, since a namespace wrongly kept in scope makes a false link.
      for (const name of remove.split(";")) if (name.trim()) out.push({ op: "remove", name: name.trim() });
      continue;
    }
    const include = attr("Include");
    if (conditional || include === undefined || !/^[A-Za-z_][\w.]*$/.test(include) || attr("Alias") !== undefined) continue;
    // `Static="true"` is a `using static` of that type, project-wide: recorded like a `global using static`.
    out.push({ op: "add", name: include });
  }
  return out;
}

const SDK_BASE = ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks"];
const SDK_HOSTING = ["Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging"];

/**
 * The namespaces the .NET SDK imports as global usings under `<ImplicitUsings>`, by SDK (the SDK's own
 * `Microsoft.NET.Sdk.*.props`). Razor adds none of its own; the WebAssembly Blazor SDK adds only Configuration, DependencyInjection and
 * Logging (per the SDK's props — its component namespaces come from `_Imports.razor`, not a global using). An SDK not listed (a custom one that does not wrap `Microsoft.NET.Sdk`) names nothing.
 */
const SDK_IMPLICIT_USINGS: Array<[sdk: RegExp, namespaces: string[]]> = [
  [/^Microsoft\.NET\.Sdk\.Web$/i, [...SDK_BASE, "System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing", ...SDK_HOSTING]],
  [/^Microsoft\.NET\.Sdk\.Worker$/i, [...SDK_BASE, ...SDK_HOSTING]],
  [/^Microsoft\.NET\.Sdk\.BlazorWebAssembly$/i, [...SDK_BASE, "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Logging"]],
  [/^Microsoft\.NET\.Sdk(?:\.Razor)?$/i, SDK_BASE],
];

/** The SDK names a project file states (`Sdk="…"` on `<Project>`, `<Sdk Name>`, `<Import Sdk>`), without a `/version` suffix. */
function sdkNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<(?:Project|Import)\b[^>]*?\bSdk\s*=\s*"([^"]+)"|<Sdk\b[^>]*?\bName\s*=\s*"([^"]+)"/gi)) {
    for (const name of (m[1] ?? m[2]!).split(";")) out.push(name.trim().replace(/\/[^/]*$/, ""));
  }
  return out;
}

/**
 * `<ImplicitUsings>enable</ImplicitUsings>`: true/false for the last unconditional literal value the file sets,
 * null when it says nothing (a `Condition` on the element or its group, or a `$(…)` value, is not a fact).
 */
function implicitUsingsSetting(text: string): boolean | null {
  const unconditional = text.replace(/<PropertyGroup\b[^>]*\bCondition\s*=[^>]*>[\s\S]*?<\/PropertyGroup>/gi, "");
  let value: string | undefined;
  for (const m of unconditional.matchAll(/<ImplicitUsings\b([^>]*)>\s*([^<]*?)\s*<\/ImplicitUsings>/gi)) {
    if (/\bCondition\s*=/i.test(m[1]!) || m[2]!.includes("$(")) continue;
    value = m[2]!;
  }
  return value === undefined ? null : /^(?:enable|true)$/i.test(value);
}

/** True when a props file imports the one above it (`GetPathOfFileAbove('Directory.Build.props', …)`). */
function importsParentProps(text: string): boolean {
  return /<Import\b[^>]*GetPathOfFileAbove\s*\(\s*['"]Directory\.Build\.props['"]/i.test(text);
}

/**
 * The namespaces MSBuild imports into every file of a project, applied in MSBuild's evaluation order: the SDK's
 * implicit global usings when `<ImplicitUsings>` is enabled (the project's own value, else the nearest props
 * file's that sets one), then the `<Using>` items of `Directory.Build.props` — beside the project file or above
 * it, and each parent it imports, outermost first — then the project's own, each `<Using Remove>` taking away
 * what came before it (so a Remove in the props and an Include in the project keeps the namespace).
 */
export async function projectFileUsings(text: string, file: SelfNameContext): Promise<string[]> {
  if (!/\.(?:cs|vb)proj$/i.test(file.fileName)) return [];
  const sibling = await file.readSibling("Directory.Build.props");
  const above = await file.readAncestors("Directory.Build.props");
  // Nearest first; a props file contributes its parent only when it imports it.
  const candidates = sibling !== null ? [sibling, ...above] : above;
  const chain: string[] = [];
  for (const props of candidates) {
    chain.push(props);
    if (!importsParentProps(props)) break;
  }
  const names = new Set(sdkNames(text));
  const sdk = SDK_IMPLICIT_USINGS.find(([re]) => [...names].some((n) => re.test(n)));
  const setting = implicitUsingsSetting(text) ?? chain.map(implicitUsingsSetting).find((v) => v !== null) ?? null;
  const ops: UsingOp[] = [];
  if (sdk && /\.csproj$/i.test(file.fileName) && setting) for (const name of sdk[1]) ops.push({ op: "add", name });
  for (const props of [...chain].reverse()) ops.push(...usingOps(props));
  ops.push(...usingOps(text));
  const out = new Set<string>();
  for (const { op, name } of ops) {
    if (op === "add") out.add(name);
    else out.delete(name);
  }
  return [...out];
}

/**
 * `<ProjectReference Include="..\\Core\\Core.csproj" />`: the directory of the
 * referenced project file, posix. A reference with a `$(…)` property names
 * nothing statically. Not a project file (`Directory.Packages.props`): none.
 */
export function projectFileReferences(text: string, file: SelfNameContext): ProjectReference[] {
  if (!/\.(?:cs|fs|vb)proj$/i.test(file.fileName)) return [];
  const out: ProjectReference[] = [];
  for (const m of text.matchAll(/<ProjectReference\s+[^>]*?\bInclude\s*=\s*"([^"]+)"/gi)) {
    const path = m[1]!.replace(/\\/g, "/");
    if (path.includes("$(")) continue;
    const slash = path.lastIndexOf("/");
    out.push({ path: slash < 0 ? "." : path.slice(0, slash) });
  }
  return out;
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
      projectImports: projectFileUsings,
      projectReferences: projectFileReferences,
    },
  ],
  // The full namespace (`Microsoft.EntityFrameworkCore.Metadata`): it extends
  // the package id, or the id extends it (`Microsoft.Extensions.Http`).
  importKey: (s) => s.toLowerCase(),
  prefixMatch: { separator: ".", bidirectional: true },
};
