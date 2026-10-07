import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { juliaPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const juliaManifest: LanguagePluginManifest = {
  language: "julia",
  family: "julia",
  packageManagers: [juliaPackageManager],
  packageEcosystems: ["julia"],
  parsing: "tree-sitter",
  extensions: [".jl"],
  grammar: { variants: { julia: { pkg: "tree-sitter-julia", wasm: "tree-sitter-julia.wasm" } } },
  // `include("db.jl")` pastes db.jl's definitions into the including file.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)test\/.*\.jl$/],
  frameworkImportHints: { Genie: "genie", Oxygen: "oxygen", HTTP: "http-jl", LibPQ: "libpq", SearchLight: "searchlight" },
};
