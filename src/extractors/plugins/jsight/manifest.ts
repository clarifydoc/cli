import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types only.
 */
export const jsightManifest: LanguagePluginManifest = {
  language: "jsight",
  parsing: "regex",
  extensions: [".jsight"],
  importTarget: false,
};
