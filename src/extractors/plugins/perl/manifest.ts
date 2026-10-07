import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { cpanPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const perlManifest: LanguagePluginManifest = {
  language: "perl",
  family: "perl",
  packageManagers: [cpanPackageManager],
  packageEcosystems: ["cpan"],
  parsing: "regex",
  // `.t` tests, `.psgi` PSGI app entries, `.cgi` scripts (only Perl ones — meta.ts).
  extensions: [".pl", ".pm", ".t", ".psgi", ".cgi"],
  // Web frameworks a module's `use` names: an app with no cpanfile is still
  // a Catalyst app (and Catalyst loads its controllers by namespace).
  frameworkImportHints: {
    Catalyst: "catalyst",
    "Catalyst::Runtime": "catalyst",
    Mojolicious: "mojolicious",
    "Mojolicious::Lite": "mojolicious",
    Dancer: "dancer",
    Dancer2: "dancer",
  },
  testFilePatterns: [/\.t$/],
};
