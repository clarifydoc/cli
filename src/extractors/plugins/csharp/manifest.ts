import { csharpMigrationFiles } from "./migration-files.js";
import { dotnetProjectCommands } from "./project-commands.js";
import { dotnetTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { csharpFrameworkRules } from "./frameworks.js";
import { nugetPackageManager } from "./package-manifests.js";
import { csharpServiceConfig } from "./service-config.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and service-config.ts only.
 */
export const csharpManifest: LanguagePluginManifest = {
  migrationFiles: csharpMigrationFiles,
  testCommand: dotnetTestCommand,
  projectCommands: dotnetProjectCommands,
  language: "csharp",
  family: "dotnet",
  // `var u = await repo.FindAsync(id)` holds the `User` a declared `Task<User>` resolves to.
  asyncResultTypes: ["Task", "ValueTask"],
  packageManagers: [nugetPackageManager],
  packageEcosystems: ["nuget"],
  // appsettings*.json + launchSettings, `IConfiguration[...]`, `__` env overrides.
  serviceConfig: csharpServiceConfig,
  parsing: "tree-sitter",
  // `.csx`: C# script (dotnet-script, Roslyn scripting) — see script.ts.
  extensions: [".cs", ".csx"],
  // One type spans files here: `partial` classes split one type across files.
  typesSpanFiles: true,
  // `using League.Clubs;` names a namespace, which any file may declare.
  importsNamePackages: true,
  // A type name is found in the file's namespace, each enclosing one, then its usings.
  nestedPackageLookup: true,
  grammar: { variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } } },
  // `ClubTests.cs`, and anything in a .NET test project (`League.Core.Test/`, `League.Api.IntegrationTests/`).
  testFilePatterns: [/(Test|Tests)\.cs$/, /(^|[\\/])[\w.]+\.(?:Unit|Integration|Functional|Acceptance)?Tests?[\\/]/],
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
