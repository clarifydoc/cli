import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { htmlSpec, htmlPreprocess } from "./index.js";
import { htmlManifest } from "./manifest.js";
import { materializeElementRequests } from "../shared/element-requests.js";

/**
 * Plain HTML pages (vanilla multi-page static sites). Each `.html` page becomes a
 * routed screen; its `<script src>` includes link it to the JS call graph. The
 * page's behaviour is in those JS files (owned by the JS plugin), so this plugin
 * is the page/markup half: the page route, its interactive elements, and its
 * local script imports.
 *
 * Generated API-reference pages (Doxygen, PasDoc, DocInsight, javadoc…) are
 * build artifacts, not UI — preprocess skips them so a committed docs/ tree
 * can't flood the report with phantom screens. Every other page's forms, submit
 * buttons and links that request an app path become api-calls for the route
 * linker, as a server template's do.
 */
export const htmlMeta: LanguagePluginMeta = {
  ...htmlManifest,
  regexSpec: htmlSpec,
  preprocess: (rawSource) =>
    htmlPreprocess(rawSource) ?? { sourceText: rawSource, language: "html", postExtract: (analysis) => materializeElementRequests(analysis) },
};
