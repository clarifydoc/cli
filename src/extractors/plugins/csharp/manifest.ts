import { valueOut } from "../../shared/value-out.js";
import { collectionElementText } from "../../shared/collection-element.js";
import { csharpTupleElements } from "./tuple-elements.js";
import { csharpMigrationFiles } from "./migration-files.js";
import { dotnetProjectCommands } from "./project-commands.js";
import { dotnetTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { csharpFrameworkRules } from "./frameworks.js";
import { nugetPackageManager } from "./package-manifests.js";
import { csharpServiceConfig } from "./service-config.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and service-config.ts only.
 *
 * Extension methods: `extensionsNeedImport` keeps an extension method only where its declaring file is in the
 * caller's scope — same file, the global namespace, a `using` of its namespace, its own or an enclosing namespace,
 * a `global using`, an imported project, or `using static` of its class (`extensionInScope`, built on
 * `importsFile`; `extensionMethodFor` in core/symbol-linker.ts asks it, and it needs `importsNamePackages`).
 * Languages without the flag link extension functions from anywhere in the type space. A C# namespace is not a
 * package directory for the function-type-alias scope walk.
 *
 * `importsNamePackages: true` (a `using` names a namespace any file may declare), `nestedPackageLookup: true` (a
 * type name is found in the file's namespace, each enclosing one, then its usings), `typesSpanFiles: true`
 * (`partial` classes split one type across files, so a type's parts are one type), `bareMemberReceivers: true`.
 *
 * Receivers: `bareMemberReceivers` makes a member win over a type of the same name — in `Color.Darken()` inside a
 * class with a `Shade Color` property the head is the property (`Shade.Darken`), a same-file class `Color` takes
 * no link; a member typed as the head itself (`Color Color`) leaves it to the type. A parameter or local of the
 * caller's callable of another type or no stated one hides a class head too
 * (`var Audio = factory.Make(); Audio.Click()` is no call on a project class `Audio`: `localHidesClassHead`;
 * `Audio.Instance.Click()` with no such binding keeps the class).
 *
 * Explicit interface members (`void ICar.Start()`, `FunctionInfo.explicitInterface`) never take the
 * class-qualified or bare name a same-named member of the class holds (`SymbolDef.explicitOnly`): a class-typed
 * receiver reaches the public member, an interface-typed one the explicit implementation
 * (`explicitImplementation`).
 *
 * Nested types: a call through a nested type's owner path (`Right.Builder.build()`) reaches the class nested in
 * that owner, never a namesake nested elsewhere; where no class is nested in the head's own lines, the one
 * `ownerPathType` finds (a generated class's `nestedPath`, a nested type the owner inherits through its bases) is
 * used.
 *
 * `projectMarkers` `**\/*.csproj` and `**\/*.sln` (kind `dotnet`, priority 30; a .NET `.sln` adds nothing beyond
 * them: each `ProjectReference` is already a `SubProject.references` entry), `dispatchLanguages: ["vb", "xaml"]`
 * (the UI-bridge resolver joins VB and XAML code-behind too, so a pure-VB MAUI project must still load this
 * plugin), `callPathsFromHead`, `linksFromBase` (Blazor code-behind `Nav.NavigateTo("orders")` and MAUI Shell
 * `GoToAsync("Basket")` name app-root routes), `docComments: C_STYLE_DOCS`. Generated files: `*.Designer.cs`,
 * `*.g.cs`, `*.g.i.cs` (case-sensitive, so a hand-written `ReportDesigner.cs` is not swept up). Test files:
 * `…Test(s).cs` and anything in a .NET test project folder (`League.Core.Test/`, `League.Api.IntegrationTests/`);
 * `testSubjectAffixes` `Tests`/`Test`. External-module prefixes `System`, `Microsoft.`, `Newtonsoft.`; framework
 * import hints for `Microsoft.EntityFrameworkCore` (ef-core), `System.Data.Entity` (ef6), Dapper, NHibernate,
 * RepoDb, PetaPoco. A C# `Azure.` known-package rule never classifies a Python import (known-package tables answer
 * by ecosystem).
 *
 * Flat tree: C# is in `FLAT_TREE_LANGUAGES`; a 4,000-file C# repository's cold CPU went 67.7 s → 43.5 s with
 * identical output. In-process peak RSS is −20% on a 3,000-file C# repository under the bounded V8 heap growth
 * (about +10% user CPU, equal wall time).
 */
export const csharpManifest: LanguagePluginManifest = {
  docComments: C_STYLE_DOCS,
  migrationFiles: csharpMigrationFiles,
  testCommand: dotnetTestCommand,
  /**
   * Calls matched by name inside an `isAsync` function: `Thread.Sleep`, `….GetAwaiter().GetResult` (as in
   * `task.GetAwaiter().GetResult()`),
   * `Task.WaitAll`/`WaitAny`. `.Result` is a property and `.Wait()` a method any project class may have, so neither
   * is listed here.
   */
  blockingCalls: /^(?:Thread\.Sleep|Task\.(?:WaitAll|WaitAny)|.+\.GetAwaiter\(\)\.GetResult)$/,
  /**
   * `Task.Wait()` (`task.Wait()` where `task` is declared a `Task`/`Task<T>`): `{ receiverTypes, members, types }` flags
   * `receiver.member()` in an async function when the receiver's declared type matches — a parameter, a local's
   * stated type, a field of the caller's class, or the declared return of the call it was initialized from
   * (`own()`, `field.method()` through a class the project declares once; `repo.SaveAsync().Wait()` is typed by
   * `SaveAsync`'s declared return); an unknown type, a project class named like the type, or a sync method flags
   * nothing. `.Result` is a property read no call states: with `readMembers` (`Result`) the plugin states
   * `FunctionInfo.propertyReads`; the property-read edge is not built, the reads feed only the blocking-call rule.
   */
  blockingOnReceiver: { receiverTypes: /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)(?:<[\s\S]*>)?$/, members: /^Wait$/, types: ["Task", "ValueTask"], readMembers: /^Result$/ },
  projectCommands: dotnetProjectCommands,
  language: "csharp",
  overloadedMembers: true,
  lexicalClassRanges: true,
  callPathsFromHead: true,
  collectionElementOf: collectionElementText,
  // `var (club, player) = Load();` over a declared `(Club, Player)` / `(Club club, Player player)`.
  tupleElementsOf: csharpTupleElements,
  // Blazor code-behind's `Nav.NavigateTo("orders")` and MAUI Shell's `GoToAsync("Basket")` name app-root routes.
  linksFromBase: true,
  family: "dotnet",
  /**
   * `var u = await repo.FindAsync(id)` holds the `User` a declared `Task<User>` resolves to.
   *
   * Unwrapping: `asyncResultTypes: ["Task", "ValueTask"]` unwraps `Task<T>` (a local bound to
   * `await repo.FindAsync(id)` takes the type inside the declared `Task<User>`; such a local is stated as
   * `localTypes[].from` with `awaited`). `valueOut` members: `.Value` on `Lazy<T>` / `IOptions<T>` /
   * `IOptionsSnapshot<T>` and `CurrentValue` on `IOptionsMonitor<T>` read a head, field or method result that
   * DECLARES a listed wrapper (`_options.Value.Reload()`, read by `unwrappedDeclared`/`wrappedHead` in
   * `core/symbol-linker.ts` from the written type); a project class's own `Value` property is not unwrapped (a
   * wrapper whose members are its own is not listed). A local holding the unwrapped value
   * (`var s = _options.Value; s.Reload()`) is stated as `localTypes[].from = "_options.Value"` with `member: true`
   * — the plugin states EVERY plain member-read initializer (`var m = club.Boss`) and core decides (a listed
   * wrapper unwraps, else the member's declared type).
   */
  asyncResultTypes: ["Task", "ValueTask"],
  // `_repo.Value` of a declared `Lazy<ClubRepo>`, `_options.Value` of an `IOptions<ClubSettings>`.
  valueOut: valueOut({ members: { Value: ["Lazy", "IOptions", "IOptionsSnapshot"], CurrentValue: ["IOptionsMonitor"] } }),
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
  // An extension method is callable only where its namespace (or its static class) is imported.
  extensionsNeedImport: true,
  bareMemberReceivers: true,
  grammar: { variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } } },
  // `ClubTests.cs`, and anything in a .NET test project (`League.Core.Test/`, `League.Api.IntegrationTests/`).
  testFilePatterns: [/(Test|Tests)\.cs$/, /(^|[\\/])[\w.]+\.(?:Unit|Integration|Functional|Acceptance)?Tests?[\\/]/],
  testSubjectAffixes: { suffixes: ["Tests", "Test"] },
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
  // Files that mark a sub-project root (core's project detector); a lower `priority` wins a directory holding several kinds.
  projectMarkers: [
    { pattern: "**/*.csproj", kind: "dotnet", priority: 30 },
    { pattern: "**/*.sln", kind: "dotnet", priority: 30 },
  ],
};
