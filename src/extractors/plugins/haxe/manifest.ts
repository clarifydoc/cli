import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { haxelibPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY. This module must stay a leaf: types and package-manifests.ts only.
 */
export const haxeManifest: LanguagePluginManifest = {
  language: "haxe",
  family: "haxe",
  packageManagers: [haxelibPackageManager],
  packageEcosystems: ["haxelib"],
  parsing: "regex",
  extensions: [".hx"],
  testFilePatterns: [/Test\.hx$/, /(?:^|\/)tests?\/.*\.hx$/],
  externalModulePrefixes: ["haxe.", "sys.", "js.", "tink."],
  frameworkImportHints: { "tink.web": "tink-web", "js.node": "hxnodejs" },
};
