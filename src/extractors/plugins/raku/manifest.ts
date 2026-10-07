import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { rakuPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types and package-manifests.ts only.
 */
export const rakuManifest: LanguagePluginManifest = {
  language: "raku",
  family: "raku",
  packageManagers: [rakuPackageManager],
  packageEcosystems: ["raku"],
  parsing: "regex",
  // Only Raku's own extensions: a `.pl`/`.pm` written in Raku (`use v6`) is Perl's to claim.
  extensions: [".raku", ".rakumod", ".rakutest", ".p6", ".pm6", ".pl6", ".t6"],
  // `use Shop::Crm` imports the module's `is export` subs by name.
  importsShareScope: true,
  testFilePatterns: [/\.(?:rakutest|t6)$/, /(?:^|\/)t\//],
  frameworkImportHints: { "Cro::HTTP::Router": "cro", "Cro::HTTP::Server": "cro", "Humming-Bird::Core": "humming-bird", DBIish: "dbiish" },
  activationFiles: ["META6.json"],
  // A distribution's scripts live in `bin/`, a directory discovery skips as build output.
  sourceDirs: [{ dir: "bin", marker: "META6.json" }],
};
