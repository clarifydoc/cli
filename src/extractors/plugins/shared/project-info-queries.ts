import type { ProjectInfo } from "../../../types/plugin.js";

/**
 * Predicate helpers over `ProjectInfo` for plugin framework rules
 * (`LanguagePluginMeta.frameworkRules`). Each queries one manifest ecosystem;
 * a rule composes them into a framework detection. Leaf module — types only —
 * so plugin metas can import it without touching core or the registry.
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** npm: `dependencies` / `devDependencies` in package.json. */
export function hasDep(info: ProjectInfo, name: string): boolean {
  if (!info.packageJson) return false;
  const deps = info.packageJson.dependencies as Record<string, string> | undefined;
  const devDeps = info.packageJson.devDependencies as Record<string, string> | undefined;
  return !!(deps?.[name] || devDeps?.[name]);
}

/** Python: requirements.txt lines or pyproject dependency strings (prefix match). */
export function hasPythonDep(info: ProjectInfo, name: string): boolean {
  if (!info.pythonManifest) return false;
  const deps = info.pythonManifest.dependencies as string[] | undefined;
  if (Array.isArray(deps)) {
    return deps.some((d) => d.toLowerCase().startsWith(name));
  }
  // Check requirements-style
  const all = JSON.stringify(info.pythonManifest).toLowerCase();
  return all.includes(name);
}

/** Gradle: substring of build.gradle(.kts). */
export function hasGradleDep(info: ProjectInfo, name: string): boolean {
  if (!info.gradleFile) return false;
  return info.gradleFile.includes(name);
}

/** Delphi: any aggregated uses-clause unit starting with `name`. */
export function hasDelphiDep(info: ProjectInfo, name: string): boolean {
  return info.delphiUses.some((u) => u.startsWith(name));
}

/** Maven: substring of pom.xml. */
export function hasMavenDep(info: ProjectInfo, name: string): boolean {
  if (!info.pomXml) return false;
  return info.pomXml.includes(name);
}

export function hasCsprojPackage(info: ProjectInfo, name: string): boolean {
  if (!info.csprojText) return false;
  // `<PackageReference Include="Microsoft.EntityFrameworkCore" ...>`. The match
  // is anchored at the start of the name only (no closing `"`), so it is a
  // prefix match — `"Microsoft.AspNetCore.Components"` also matches
  // `Microsoft.AspNetCore.Components.WebView.Wpf`.
  const re = new RegExp(`PackageReference[^>]*Include\\s*=\\s*"${escapeRegex(name)}`, "i");
  return re.test(info.csprojText);
}

/** `<Project Sdk="Microsoft.NET.Sdk.Web">` (Web SDK vs the base/Razor SDKs). */
export function hasCsprojSdk(info: ProjectInfo, sdk: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`Sdk\\s*=\\s*"${escapeRegex(sdk)}"`, "i").test(info.csprojText);
}

/** A boolean MSBuild property toggle, e.g. `<UseWPF>true</UseWPF>`. */
export function hasCsprojProp(info: ProjectInfo, prop: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`<${escapeRegex(prop)}>\\s*true\\s*</${escapeRegex(prop)}>`, "i").test(info.csprojText);
}

/** `<FrameworkReference Include="Microsoft.AspNetCore.App" />` (shared framework). */
export function hasCsprojFrameworkRef(info: ProjectInfo, name: string): boolean {
  if (!info.csprojText) return false;
  return new RegExp(`FrameworkReference[^>]*Include\\s*=\\s*"${escapeRegex(name)}`, "i").test(info.csprojText);
}

/** Go: substring of go.mod. */
export function hasGoMod(info: ProjectInfo, name: string): boolean {
  if (!info.goMod) return false;
  return info.goMod.includes(name);
}

export function hasCargoDep(info: ProjectInfo, name: string): boolean {
  if (!info.cargoToml) return false;
  // Match `name = ...` or `name = { ... }` at line start
  const re = new RegExp(`^\\s*${escapeRegex(name)}\\s*=`, "m");
  return re.test(info.cargoToml);
}

/** Composer: `"vendor/pkg"` appearing anywhere in composer.json. */
export function hasComposerDep(info: ProjectInfo, name: string): boolean {
  if (!info.composerJson) return false;
  return info.composerJson.includes(`"${name}"`);
}

export function hasGemfileDep(info: ProjectInfo, name: string): boolean {
  if (!info.gemfile) return false;
  // `gem "name"` or `gem 'name'`
  const re = new RegExp(`gem\\s+['"]${escapeRegex(name)}['"]`, "m");
  return re.test(info.gemfile);
}

export function hasPubspecDep(info: ProjectInfo, name: string): boolean {
  if (!info.pubspecYaml) return false;
  // A dependency is an indented `  name:` key under dependencies/dev_dependencies.
  // The leading whitespace requirement avoids matching the top-level `flutter:`
  // config section (which is column-0) — only the `flutter:` *dependency* counts.
  const re = new RegExp(`^\\s+${escapeRegex(name)}\\s*:`, "m");
  return re.test(info.pubspecYaml);
}

/** `.package(url: "https://github.com/vapor/vapor.git", ...)` / `.product(name: "Fluent", ...)`. */
export function hasSwiftPackage(info: ProjectInfo, name: string): boolean {
  if (!info.packageSwift) return false;
  return new RegExp(`(github\\.com/[\\w-]+/${escapeRegex(name)}\\b|name:\\s*"${escapeRegex(name)}")`, "i")
    .test(info.packageSwift);
}

/** Lein `[compojure "1.7.0"]` or deps.edn `compojure/compojure {:mvn/version ...}`. */
export function hasCljDep(info: ProjectInfo, name: string): boolean {
  if (!info.cljProject) return false;
  return new RegExp(`[\\[{ ]${escapeRegex(name)}[/ "]`).test(info.cljProject);
}
