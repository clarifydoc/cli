import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types only.
 */
export const sfmarkupManifest: LanguagePluginManifest = {
  language: "sfmarkup",
  // The markup states what it binds by name; its behaviour is in Apex classes and, for Aura, script files.
  family: "apex",
  parsing: "regex",
  // Aura components and applications, Visualforce pages and components. A file with neither tag family is refused by `preprocess`.
  extensions: [".cmp", ".app", ".page", ".component"],
  importTarget: false,
  caseInsensitiveNames: true,
};
