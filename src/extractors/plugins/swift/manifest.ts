import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { swiftFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const swiftManifest: LanguagePluginManifest = {
  language: "swift",
  parsing: "regex",
  extensions: [".swift"],
  frameworkRules: swiftFrameworkRules,
  activationFiles: ["Package.swift"],
};
