import type { RegexLangSpec } from "../shared/regex-base.js";

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
};
