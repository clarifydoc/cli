import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { htmlSpec } from "./index.js";
import { htmlManifest } from "./manifest.js";

/**
 * Plain HTML pages (vanilla multi-page static sites). Each `.html` page becomes a
 * routed screen; its `<script src>` includes link it to the JS call graph. The
 * page's behaviour is in those JS files (owned by the JS plugin), so this plugin
 * is the page/markup half: the page route, its interactive elements, and its
 * local script imports.
 */
export const htmlMeta: LanguagePluginMeta = {
  ...htmlManifest,
  regexSpec: htmlSpec,
};
