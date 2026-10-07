import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Static tier of this plugin. This module must stay a leaf: types only. */
export const applescriptManifest: LanguagePluginManifest = {
  language: "applescript",
  family: "applescript",
  parsing: "regex",
  extensions: [".applescript"],
  // Handler names are case-insensitive: `saveOrder()` calls `on SaveOrder()`.
  caseInsensitiveNames: true,
};
