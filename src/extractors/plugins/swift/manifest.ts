import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { swiftFrameworkRules } from "./frameworks.js";
import { swiftpmPackageManager, cocoapodsPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const swiftManifest: LanguagePluginManifest = {
  language: "swift",
  family: "swift",
  packageManagers: [swiftpmPackageManager, cocoapodsPackageManager],
  packageEcosystems: ["swiftpm", "cocoapods"],
  parsing: "regex",
  extensions: [".swift"],
  // One type spans files here: `extension`s add to a type from other files.
  typesSpanFiles: true,
  frameworkRules: swiftFrameworkRules,
  activationFiles: ["Package.swift"],
};
