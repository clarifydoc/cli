import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { htmlSpec, htmlPreprocess } from "./index.js";
import { htmlManifest } from "./manifest.js";
import { materializeElementRequests } from "../shared/element-requests.js";
import { readTemplate } from "../templates/index.js";
import { htmlProjectRootPages } from "./project-root-pages.js";

/** Django / Jinja template tags: a page with these is a server template, not a static page. */
const DJANGO_TEMPLATE_RE = /\{%-?\s*(?:extends|block|load|url|include|csrf_token|endblock|trans|blocktrans|for|endfor|if|endif|set|macro)\b/;

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
  // A sub-project's own dev server serves its pages from its root.
  routeResolvers: [htmlProjectRootPages],
  preprocess: (rawSource) =>
    htmlPreprocess(rawSource) ?? {
      sourceText: rawSource,
      language: "html",
      // A Django / Jinja template is served by the view that renders it, never at its own
      // path: it is read as a server template (partials, `{% url %}` targets, htmx), without a page route.
      // A Jekyll page (front matter first) is served at its path, Liquid tags and all.
      postExtract: DJANGO_TEMPLATE_RE.test(rawSource) && !/^\uFEFF?---\r?\n/.test(rawSource)
        ? (analysis, raw) => {
          analysis.routes = [];
          readTemplate(analysis, raw, "django");
        }
        : (analysis) => materializeElementRequests(analysis),
    },
};
