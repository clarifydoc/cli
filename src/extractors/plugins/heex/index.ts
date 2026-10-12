import type { ScreenInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { readHeex } from "../elixir/heex.js";

/**
 * A Phoenix template is a screen: `templates/site/settings.html.heex` (Phoenix
 * ≤1.6) or `controllers/site_html/settings.html.heex` (1.7) renders action
 * `settings` of SiteController → `site#settings`; a co-located LiveView
 * template (`live/settings_live.html.heex`) is that LiveView's markup. Mail
 * and layout templates are not screens.
 */
function screenOf(filePath: string, text: string): ScreenInfo | null {
  if (/(?:^|\/)(?:layouts|mjml|emails?|mailer)\//.test(filePath) || /\.(?:text|mjml)\.eex$/.test(filePath)) return null;
  const base = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.html\.(?:heex|eex|leex)$|\.(?:heex|eex|leex)$/, "");
  if (base.startsWith("_")) return null;
  const dir = filePath.slice(0, filePath.lastIndexOf("/"));
  const view = /(?:^|\/)templates\/(.+)$/.exec(dir)?.[1] ?? /(?:^|\/)([^/]+)_html$/.exec(dir)?.[1] ?? null;
  const name = view ? `${view}#${base}` : base;
  const read = readHeex(text);
  return {
    name,
    formType: view ? "PhoenixTemplate" : "LiveView",
    caption: read.caption,
    dimensions: null,
    components: read.components,
    filePath,
    routePath: null,
    navigatesTo: read.elements.filter((e) => e.request?.method === "GET").map((e) => e.request!.target),
  };
}

export const heexSpec: RegexLangSpec = {
  language: "heex",
  extensions: [".heex", ".eex", ".leex"],
  blockStyle: "brace",
  lineCommentPrefixes: [],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  extractInteractiveElements: (lines) => readHeex(lines.join("\n")).elements,
  extractSubComponents: (lines) => readHeex(lines.join("\n")).subComponents,
  extractScreens: (lines, filePath) => {
    const screen = screenOf(filePath, lines.join("\n"));
    return screen ? [screen] : [];
  },
};
