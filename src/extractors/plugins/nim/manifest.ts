import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { nimblePackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const nimManifest: LanguagePluginManifest = {
  language: "nim",
  family: "nim",
  packageManagers: [nimblePackageManager],
  packageEcosystems: ["nimble"],
  parsing: "regex",
  // `.nimble` package files are read by the inventory and reachability, not analyzed.
  extensions: [".nim", ".nims"],
  // `import utils` puts every exported routine of utils.nim in scope unqualified.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)test_[^/]*\.nims?$/, /_test\.nims?$/],
  externalModulePrefixes: ["std/"],
  frameworkImportHints: { jester: "jester", prologue: "prologue", karax: "karax" },
};
