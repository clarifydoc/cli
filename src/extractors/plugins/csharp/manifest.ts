import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { csharpFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const csharpManifest: LanguagePluginManifest = {
  language: "csharp",
  parsing: "tree-sitter",
  extensions: [".cs"],
  grammar: { variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } } },
  testFilePatterns: [/(Test|Tests)\.cs$/],
  externalModulePrefixes: ["System", "Microsoft.", "Newtonsoft."],
  externalNamespaceRoots: ["System", "Microsoft"],
  frameworkImportHints: { "Microsoft.EntityFrameworkCore": "ef-core", "System.Data.Entity": "ef6", Dapper: "dapper", NHibernate: "nhibernate", RepoDb: "repodb", PetaPoco: "petapoco" },
  frameworkRules: csharpFrameworkRules,
  // CsharpUiBridgeResolver joins VB/XAML code-behind too (partial-class join
  // is language-agnostic) — a pure-VB MAUI project must still load this plugin.
  dispatchLanguages: ["vb", "xaml"],
};
