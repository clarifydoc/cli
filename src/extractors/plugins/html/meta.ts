import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { htmlSpec } from "./index.js";

/**
 * Plain HTML pages (vanilla multi-page static sites). Each `.html` page becomes a
 * routed screen; its `<script src>` includes link it to the JS call graph. The
 * page's behaviour is in those JS files (owned by the JS plugin), so this plugin
 * is the page/markup half: the page route, its interactive elements, and its
 * local script imports.
 */
export const htmlMeta: LanguagePluginMeta = {
  language: "html",
  parsing: "regex",
  extensions: htmlSpec.extensions,
  regexSpec: htmlSpec,
  // HTML pages are reached by `<a href>` navigation, not by module import, and a
  // page often shares a basename stem with its sibling script (`index.html` /
  // `index.js`) — keeping it out of the import path map avoids a basename
  // collision that would mis-resolve `<script src>` includes.
  importTarget: false,
};
