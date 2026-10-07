import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { rubyFrameworkRules } from "./frameworks.js";
import { rubygemsPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const rubyManifest: LanguagePluginManifest = {
  language: "ruby",
  family: "ruby",
  packageManagers: [rubygemsPackageManager],
  packageEcosystems: ["rubygems"],
  parsing: "regex",
  extensions: [".rb"],
  // One type spans files here: a class can be reopened in another file of its namespace.
  typesSpanFiles: true,
  testFilePatterns: [/_(spec|test)\.rb$/],
  externalModulePrefixes: ["rails", "active_record", "active_support", "action_controller", "rspec", "bundler", "rake"],
  frameworkImportHints: { active_record: "active-record", sequel: "sequel" },
  frameworkRules: rubyFrameworkRules,
  activationFiles: ["Gemfile"],
};
