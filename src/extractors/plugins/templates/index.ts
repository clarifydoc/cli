import type { FileAnalysis, InteractiveElementInfo, ScreenComponentInfo, ScreenInfo, SubComponentInfo } from "../../../types/analysis.js";
import { inlineScriptRequests } from "../shared/inline-script-requests.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { literalPath, handlerOf, materializeElementRequests } from "../shared/element-requests.js";

/**
 * Server templates — Handlebars, Liquid, Velocity, Razor — read by one
 * scanner over the markup with each dialect's tags blanked:
 *   - partials (`{{> header}}`, `{% include 'x' %}` / `{% render 'x' %}`,
 *     `#parse("x.vm")`, `<partial name="_X" />` / `Html.PartialAsync("_X")` /
 *     `Component.InvokeAsync("X")`) → sub-components;
 *   - `<form action method>` and `<a href>` with a literal app path (a leading
 *     template expression is the base path: `{{urlpath}}/admin` → `/admin`) →
 *     elements carrying `request`, materialized as api-calls for the route
 *     linker (shared/element-requests.ts);
 *   - Razor tag helpers name the target instead of a path: `asp-controller` /
 *     `asp-action` (controller from the view folder when omitted) →
 *     `Ctl#Action`, `asp-page` / `asp-page-handler` → `page:/Path#Handler`,
 *     joined by `RazorTargetResolver`;
 *   - every other control and inline handler through the HTML reader.
 * A template is a screen when it is not a partial, a layout or a mail/prompt
 * template AND it holds something to interact with: report and mail bodies
 * have none.
 */

/** The dialects that are languages of their own (own extension, own plugin). */
export type TemplateLanguage = "handlebars" | "liquid" | "velocity" | "razor" | "gotemplate" | "freemarker";
/** Django's templates are `.html`, which the HTML plugin owns and hands here. */
export type TemplateDialect = TemplateLanguage | "django";

const TAGS: Record<TemplateDialect, RegExp> = {
  handlebars: /\{\{\{?[\s\S]*?\}?\}\}/g,
  liquid: /\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g,
  velocity: /#\*[\s\S]*?\*#|##[^\n]*|#\{?(?:if|else|elseif|end|foreach|set|parse|include|macro|define|break|stop)\}?(?:\([^)\n]*\))?|\$!?\{?[\w.]+(?:\([^)\n]*\))?\}?/g,
  razor: /@\*[\s\S]*?\*@|@\{[\s\S]*?\n\}|@\([^)\n]*\)|@[A-Za-z_][\w.]*(?:\([^)\n]*\))?/g,
  gotemplate: /\{\{[\s\S]*?\}\}/g,
  django: /\{#[\s\S]*?#\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g,
  freemarker: /<#--[\s\S]*?-->|<\/?[#@][^>]*>|\$\{[^}]*\}/g,
};

const PARTIALS: Record<TemplateDialect, RegExp> = {
  handlebars: /\{\{>\s*["']?([\w/.-]+)/g,
  liquid: /\{%-?\s*(?:include|render|section)\s+["']([\w/.-]+)["']/g,
  velocity: /#(?:parse|include)\s*\(\s*["']([\w/.-]+)["']/g,
  razor: /<partial\s+name\s*=\s*["']([\w/.~-]+)["']|Html\.Partial(?:Async)?\(\s*"([\w/.~-]+)"|Html\.RenderPartial(?:Async)?\(\s*"([\w/.~-]+)"|Component\.InvokeAsync\(\s*"(\w+)"/g,
  gotemplate: /\{\{-?\s*template\s+"([\w/.-]+)"/g,
  django: /\{%-?\s*include\s+["']([\w/.-]+)["']/g,
  freemarker: /<#(?:include|import)\s+["']([\w/.-]+)["']/g,
};

/**
 * A URL a template builds from a route's name — Django `{% url 'clubs:detail' club.pk %}` —
 * written as a marked path so the form/link reader keeps it; `namedTarget` reads it back as
 * `route:clubs:detail`, which the plugin of the routes resolves.
 */
const NAMED_URL: Partial<Record<TemplateDialect, RegExp>> = {
  // Django `{% url 'clubs:detail' pk %}`, Jinja's `{{ url_for('clubs.detail', id=c.id) }}` (Flask, Starlette).
  django: /\{%-?\s*url\s+(['"])([\w.:-]+)\1[^%]*%\}|\{\{-?\s*url_for\(\s*(['"])((?!static\3)[\w.:-]+)\3[^}]*\}\}/g,
};
const ROUTE_MARK = "/__route__/";
const namedTarget = (target: string): string => (target.startsWith(ROUTE_MARK) ? `route:${target.slice(ROUTE_MARK.length).replace(/~/g, ":")}` : target);
/** htmx requests an element sends: `hx-post="{% url 'clubs:add' %}"`, `hx-get="/clubs"`. */
const HTMX_RE = /<([a-zA-Z][\w-]*)\b[^>]*?\bhx-(get|post|put|patch|delete)\s*=\s*["']([^"']*)["']/g;

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];

/** `{{urlpath}}/admin`, `/admin?x=1`, `@Url.Content("~/x")` stays out → `/admin`; null when not an app path. */
/** The view's controller, from `Views/<Ctl>/<Action>.cshtml`. */
const viewController = (filePath: string): string | null => /(?:^|\/)Views\/([^/]+)\/[^/]+\.cshtml$/.exec(filePath)?.[1] ?? null;

export function readTemplate(analysis: FileAnalysis, source: string, dialect: TemplateDialect): void {
  const filePath = analysis.filePath;
  const elements: InteractiveElementInfo[] = [];
  const subComponents: SubComponentInfo[] = [];
  const components: ScreenComponentInfo[] = [];
  const navigatesTo = new Set<string>();
  const component = (name: string, componentType: string, category: ScreenComponentInfo["category"], line: number, events: string[]): void => {
    components.push({ name, componentType, category, caption: null, position: null, align: null, visible: true, children: [], events, dataBindings: [], line });
  };

  PARTIALS[dialect].lastIndex = 0;
  for (const m of source.matchAll(PARTIALS[dialect])) {
    const name = (m[1] ?? m[2] ?? m[3] ?? m[4])!;
    const line = lineAt(source, m.index!);
    subComponents.push({ name: name.split("/").pop()!.replace(/\.\w+$/, ""), importSource: null, props: [], line });
    component(name, "partial", "container", line, []);
  }

  // Tag helpers and forms read on the raw text (their attributes are what blanking would erase),
  // a URL built from a route name marked first (one line for one line).
  const named = NAMED_URL[dialect];
  const marked = named ? source.replace(named, (_m, _q, name: string | undefined, _q2, name2: string | undefined) => ROUTE_MARK + (name ?? name2)!.replace(/:/g, "~")) : source;
  const ctlOfView = dialect === "razor" ? viewController(filePath) : null;
  for (const t of marked.matchAll(/<(form|a|button)\b([^>]*)>/gi)) {
    const tag = t[1]!.toLowerCase();
    const attrs = t[2] ?? "";
    const line = lineAt(marked, t.index!);
    const isForm = tag === "form";
    const method = ((attr(attrs, "method") ?? (isForm ? "post" : "get"))).toUpperCase();
    let target: string | null = null;
    if (dialect === "razor") {
      const page = attr(attrs, "asp-page");
      const action = attr(attrs, "asp-action");
      if (page !== undefined) target = `page:${page || "."}${attr(attrs, "asp-page-handler") ? `#${attr(attrs, "asp-page-handler")}` : ""}`;
      else if (action) target = `${attr(attrs, "asp-controller") ?? ctlOfView ?? "Home"}#${action}`;
    }
    target ??= literalPath(attr(attrs, isForm ? "action" : "href"));
    if (target) target = namedTarget(target);
    if (!target || tag === "button") continue;
    const handler = handlerOf(method, target.replace(/^route:/, "/").replace(/:/g, "/"));
    elements.push({ element: isForm ? "form" : "link", event: isForm ? "submit" : "click", handler, line, request: { method, target } });
    component(target, tag, isForm ? "container" : "navigation", line, [`${isForm ? "submit" : "click"}: ${handler}`]);
    if (!isForm && method === "GET") navigatesTo.add(target);
  }

  if (dialect === "django") {
    for (const h of marked.matchAll(HTMX_RE)) {
      const target = literalPath(h[3]);
      if (!target) continue;
      const request = { method: h[2]!.toUpperCase(), target: namedTarget(target) };
      const handler = handlerOf(request.method, request.target.replace(/^route:/, "/").replace(/:/g, "/"));
      elements.push({ element: "button", event: "click", handler, line: lineAt(marked, h.index!), request });
    }
  }

  const readAbove = new Set(elements.map((e) => e.line));
  const markup = source.replace(TAGS[dialect], (m) => m.replace(/[^\n]/g, " "));
  for (const el of extractHtmlInteractiveElements(markup.split("\n"))) {
    if ((el.element === "form" || el.element === "link") && (el.handler === null || readAbove.has(el.line))) continue; // read above
    elements.push(el);
  }
  elements.sort((a, b) => a.line - b.line);
  analysis.interactiveElements = elements;
  analysis.subComponents = subComponents;
  materializeElementRequests(analysis);

  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const notAScreen = base.startsWith("_") || /(?:^|\/)(?:layouts?|shared|partials?|mailers?|e?mails?|email_templates|prompts?)\//i.test(filePath) || elements.length === 0;
  if (notAScreen) return;
  const stem = base.replace(/\.[\w.]+$/, "");
  const name = ctlOfView ? `${ctlOfView}#${stem}` : filePath.replace(/\.[\w.]+$/, "");
  const caption = /<title>([^<]+)<\/title>|<h1\b[^>]*>([^<]+)<\/h1>/i.exec(markup);
  const screen: ScreenInfo = {
    name,
    formType: { handlebars: "HandlebarsTemplate", liquid: "LiquidTemplate", velocity: "VelocityTemplate", gotemplate: "GoTemplate", django: "DjangoTemplate", freemarker: "FreeMarkerTemplate", razor: /(?:^|\/)Pages\//.test(filePath) ? "RazorPage" : "RazorView" }[dialect],
    caption: (caption?.[1] ?? caption?.[2])?.trim() || null,
    dimensions: null,
    components: components.sort((a, b) => a.line - b.line),
    filePath,
    routePath: dialect === "razor" ? (/^\s*@page\s+"([^"]+)"/m.exec(source)?.[1] ?? null) : null,
    navigatesTo: [...navigatesTo],
  };
  analysis.screens = [screen];
}

export const templateSpec = (dialect: TemplateLanguage, extensions: string[]): RegexLangSpec => ({
  language: dialect,
  extensions,
  blockStyle: "brace",
  lineCommentPrefixes: [],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [
    {
      // The page's own scripts, which bind its elements (`<script src="{{urlpath}}/static/clubs.js">`):
      // the served prefix a template expression supplies is dropped — the file is found by what follows.
      pattern: /<script\b[^>]*\bsrc\s*=\s*["'](?!https?:|\/\/)([^"']+\.[cm]?js)(?:\?[^"']*)?["']/i,
      getSource: (m) => m[1]!.replace(/^.*(?:\}\}|%>|\})/, ""),
      getSpecifiers: () => [],
    },
  ],
  // Requests the page's inline scripts make (`fetch("/clubs", { method: "POST" })`).
  extractDataSources: (lines) => inlineScriptRequests(lines),
});
