import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { dubPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const dManifest: LanguagePluginManifest = {
  language: "dlang",
  family: "dlang",
  packageManagers: [dubPackageManager],
  packageEcosystems: ["dub"],
  parsing: "regex",
  // `.d` is also a make dependency file; preprocess refuses those.
  extensions: [".d", ".di"],
  // `import app.models;` puts every public symbol of the module in scope unqualified.
  importsShareScope: true,
  externalModulePrefixes: ["std."],
  frameworkImportHints: { "vibe.d": "vibe-d", "vibe.vibe": "vibe-d", "vibe.http": "vibe-d", "vibe.web": "vibe-d" },
  activationFiles: ["dub.json", "dub.sdl"],
};
