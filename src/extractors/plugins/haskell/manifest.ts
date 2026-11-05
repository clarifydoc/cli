import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { hackagePackageManager } from "./package-manifests.js";
import { DASH_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const haskellManifest: LanguagePluginManifest = {
  docComments: DASH_DOCS,
  language: "haskell",
  family: "haskell",
  packageManagers: [hackagePackageManager],
  packageEcosystems: ["hackage"],
  parsing: "regex",
  // Read by the `tree-sitter:haskell` front end only (meta.treeSitter).
  grammar: { variants: { haskell: { pkg: "tree-sitter-haskell", wasm: "tree-sitter-haskell.wasm" } } },
  extensions: [".hs", ".lhs"],
  testFilePatterns: [/Spec\.hs$/, /Test\.hs$/],
  testSubjectAffixes: { suffixes: ["Spec", "Test"] },
  externalModulePrefixes: ["Data.", "Control.", "System.", "GHC.", "Text.", "Network.", "Prelude"],
  frameworkImportHints: { Yesod: "yesod", Servant: "servant", "Web.Scotty": "scotty", "Database.Persist": "persistent" },
};
