import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { vpmPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const vManifest: LanguagePluginManifest = {
  language: "vlang",
  family: "vlang",
  packageManagers: [vpmPackageManager],
  packageEcosystems: ["vpm"],
  parsing: "regex",
  // `.v` is also Verilog and Coq; preprocess refuses those.
  extensions: [".v", ".vsh"],
  // A type's methods sit in any file of its module directory (`fn (app App) x()`).
  typesSpanFiles: true,
  testFilePatterns: [/_test\.v$/],
  frameworkImportHints: { veb: "veb", vweb: "vweb" },
  activationFiles: ["v.mod"],
};
