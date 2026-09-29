import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClojureRoutes, extractClojureDataSources } from "./web.js";
import { attachClojureProperties, attachDefnParams, clojureRequestAccess } from "./routes.js";

/**
 * Clojure regex spec. Lisp forms are paren-balanced; the regex framework has no
 * paren block style, so extents are indent-approximated (Clojure is
 * conventionally indented). `defn`/`defn-` are functions (`defn-` = private);
 * `defrecord`/`defprotocol`/`deftype` are the class concept; `(:require […])`
 * vectors in the `ns` form are imports.
 */
export const clojureSpec: RegexLangSpec = {
  language: "clojure",
  extensions: [".clj", ".cljs", ".cljc"],
  indentBased: true,
  lineCommentPrefixes: [";"],

  functionPatterns: [
    {
      pattern: /^\s*\(defn-?\s+([^\s[\];()]+)/,
      isExported: (line) => !/\(defn-\s/.test(line), // defn- is private
    },
    { pattern: /^\s*\(defmacro\s+([^\s[\];()]+)/ },
  ],

  classPatterns: [
    { pattern: /^\s*\(defrecord\s+([A-Z][^\s[\];()]*)/ },
    { pattern: /^\s*\(deftype\s+([A-Z][^\s[\];()]*)/ },
    { pattern: /^\s*\(defprotocol\s+([A-Z][^\s[\];()]*)/ },
    // A Malli map schema `(def User [:map …])` / `(def User (m/schema [:map …]))`
    // and a Plumatic `(s/defschema User {…})` are the typed shapes a body can
    // have — the class concept for a request DTO.
    // A capitalised `(def Name` whose value opens a vector/map/`(m/schema` on
    // this or the next line is a candidate; `postProcessClasses` keeps it only
    // when the value really is a map schema.
    { pattern: /^\s*\(def\s+([A-Z][^\s[\];()]*)\s*(?:$|\(?[\w.]*\/?schema\b|\[\s*:map\b|\{)/ },
    { pattern: /^\s*\((?:[\w.]+\/)?defschema\s+([A-Z][^\s[\];()]*)/ },
  ],

  importPatterns: [
    {
      // require/import vector `[ring.adapter.jetty :refer [run-jetty]]` or `[clojure.string :as str]`
      pattern: /\[\s*([a-z][\w.-]+)\s+:(?:as|refer|refer-macros)/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split(".");
        return [parts[parts.length - 1]];
      },
    },
  ],

  callPatterns: [
    {
      // Namespaced call `(str/join …)` / `(jetty/run-jetty …)` → alias/fn.
      pattern: /\(\s*([a-z][\w.-]*)\/([a-z][\w?!*<>=+.-]*)/,
      buildName: (m) => ({ name: `${m[1]}/${m[2]}`, leafName: m[2] }),
    },
  ],

  /** `(:body req)` / `(get-in req [:params :q])` reads in a defn body — see `routes.ts`. */
  extractRequestAccess: (bodyLines) => clojureRequestAccess(bodyLines),
  /** Params from the defn arg vector (the generic paren scanner reads a Lisp head as one blob). */
  postProcessFunctions: (lines, fns) => {
    attachDefnParams(lines, fns);
    return fns;
  },
  /** Record fields (untyped) and Malli/Schema map entries (typed) as properties. */
  postProcessClasses: (lines, classes) => attachClojureProperties(lines, classes),

  extractRoutes: (lines) => extractClojureRoutes(lines),
  extractDataSources: (lines) => extractClojureDataSources(lines),
};
