import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { paketPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const fsharpManifest: LanguagePluginManifest = {
  language: "fsharp",
  family: "dotnet",
  packageManagers: [paketPackageManager],
  packageEcosystems: ["nuget"],
  parsing: "tree-sitter",
  // `.fs` is also a GLSL fragment shader's extension — meta.ts skips those.
  extensions: [".fs", ".fsi", ".fsx"],
  grammar: {
    variants: {
      fsharp: { pkg: "tree-sitter-fsharp", wasm: "tree-sitter-fsharp.wasm" },
      fsharp_signature: { pkg: "tree-sitter-fsharp", wasm: "tree-sitter-fsharp_signature.wasm" },
    },
    keyForFile: (filePath) => (filePath.toLowerCase().endsWith(".fsi") ? "fsharp_signature" : "fsharp"),
  },
  // `open M` puts module M's functions in scope by name.
  importsShareScope: true,
  testFilePatterns: [/Tests?\.fs$/, /(?:^|\/)tests?\/.*\.fs$/i],
  externalModulePrefixes: ["System", "Microsoft.", "FSharp.", "Giraffe", "Saturn", "Falco", "Dapper", "Npgsql"],
  externalNamespaceRoots: ["System", "Microsoft", "FSharp"],
  frameworkImportHints: { Giraffe: "giraffe", Saturn: "saturn", Falco: "falco", Dapper: "dapper", "Npgsql.FSharp": "npgsql-fsharp" },
};
