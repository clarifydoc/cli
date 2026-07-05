import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { clojureSpec } from "./index.js";
import { clojarsPackages } from "./packages.js";

export const clojureMeta: LanguagePluginMeta = {
  language: "clojure",
  parsing: "regex",
  extensions: clojureSpec.extensions,
  regexSpec: clojureSpec,
  testFilePatterns: [/_test\.cljc?s?$/],
  builtinTypes: new Set<string>([...COMMON_PRIMITIVES]),
  knownPackages: clojarsPackages,
  externalModulePrefixes: ["clojure.", "cljs."],
  frameworkImportHints: {
    "compojure.core": "compojure",
    "ring.adapter.jetty": "ring",
    "reitit.ring": "reitit",
    "reagent.core": "re-frame",
  },
  apiCallRoots: ["clj-http.client", "org.httpkit.client"],
};
