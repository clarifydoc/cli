import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { springxmlFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const springxmlManifest: LanguagePluginManifest = {
  language: "springxml",
  parsing: "regex",
  extensions: [".xml"],
  importTarget: false,
  frameworkRules: springxmlFrameworkRules,
  // WebflowUiBridgeResolver joins flow states to Java beans and JSP views.
  dispatchLanguages: ["jsp", "java"],
};
