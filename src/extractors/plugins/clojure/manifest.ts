import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { clojureFrameworkRules } from "./frameworks.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const clojureManifest: LanguagePluginManifest = {
  language: "clojure",
  parsing: "regex",
  extensions: [".clj", ".cljs", ".cljc"],
  testFilePatterns: [/_test\.cljc?s?$/],
  externalModulePrefixes: ["clojure.", "cljs."],
  frameworkImportHints: { "compojure.core": "compojure", "ring.adapter.jetty": "ring", "reitit.ring": "reitit", "reagent.core": "re-frame" },
  frameworkRules: clojureFrameworkRules,
  activationFiles: ["project.clj", "deps.edn"],
};
