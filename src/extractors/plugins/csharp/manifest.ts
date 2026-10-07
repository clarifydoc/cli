import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { csharpFrameworkRules } from "./frameworks.js";
import { nugetPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const csharpManifest: LanguagePluginManifest = {
  language: "csharp",
  family: "dotnet",
  packageManagers: [nugetPackageManager],
  packageEcosystems: ["nuget"],
  parsing: "tree-sitter",
  // `.csx`: C# script (dotnet-script, Roslyn scripting) — see script.ts.
  extensions: [".cs", ".csx"],
  // One type spans files here: `partial` classes split one type across files.
  typesSpanFiles: true,
  grammar: { variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } } },
  testFilePatterns: [/(Test|Tests)\.cs$/],
  // WinForms/WPF designers and Roslyn source generators. Case-sensitive so
  // `ReportDesigner.cs` — a hand-written class — is not swept up.
  generatedFilePatterns: [/\.Designer\.cs$/, /\.g\.cs$/, /\.g\.i\.cs$/],
  externalModulePrefixes: ["System", "Microsoft.", "Newtonsoft."],
  externalNamespaceRoots: ["System", "Microsoft"],
  frameworkImportHints: { "Microsoft.EntityFrameworkCore": "ef-core", "System.Data.Entity": "ef6", Dapper: "dapper", NHibernate: "nhibernate", RepoDb: "repodb", PetaPoco: "petapoco" },
  frameworkRules: csharpFrameworkRules,
  // CsharpUiBridgeResolver joins VB/XAML code-behind too (partial-class join
  // is language-agnostic) — a pure-VB MAUI project must still load this plugin.
  dispatchLanguages: ["vb", "xaml"],
};
