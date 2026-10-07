import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { cranPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const rManifest: LanguagePluginManifest = {
  language: "r",
  family: "r",
  packageManagers: [cranPackageManager],
  packageEcosystems: ["cran"],
  parsing: "tree-sitter",
  // Matched case-insensitively: `.R` and `.r` alike.
  extensions: [".r"],
  // NOT the unscoped `tree-sitter-r`: that npm name is a security placeholder.
  grammar: { variants: { r: { pkg: "@davisvaughan/tree-sitter-r", wasm: "tree-sitter-r.wasm" } } },
  // `source("R/db.R")` puts db.R's functions in scope by name.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests\/testthat\/.*\.r$/i, /(?:^|\/)test-[^/]*\.r$/i],
  frameworkImportHints: { plumber: "plumber", shiny: "shiny", DBI: "dbi" },
};
