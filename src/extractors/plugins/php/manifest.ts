import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { phpFrameworkRules, phpMarkerCandidates } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const phpManifest: LanguagePluginManifest = {
  language: "php",
  parsing: "tree-sitter",
  extensions: [".php"],
  grammar: { variants: { php: { pkg: "tree-sitter-php", wasm: "tree-sitter-php.wasm" } } },
  testFilePatterns: [/(Test|TestCase)\.php$/],
  externalModulePrefixes: ["Illuminate\\", "Symfony\\", "Doctrine\\", "Laravel\\"],
  frameworkImportHints: { "Doctrine\\ORM": "doctrine", "Illuminate\\Database": "eloquent", "Illuminate\\Database\\Eloquent": "eloquent", Propel: "propel", "Propel\\Runtime": "propel", "Envms\\FluentPDO": "fluentpdo" },
  frameworkRules: phpFrameworkRules,
  markerCandidates: phpMarkerCandidates,
  activationFiles: ["composer.json"],
};
