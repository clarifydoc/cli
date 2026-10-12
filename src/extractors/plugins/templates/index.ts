import type { FileAnalysis, InteractiveElementInfo, ScreenComponentInfo, ScreenInfo, SubComponentInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { materializeElementRequests } from "../shared/element-requests.js";

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

export type TemplateDialect = "handlebars" | "liquid" | "velocity" | "razor";

const TAGS: Record<TemplateDialect, RegExp> = {
  handlebars: /\{\{\{?[\s\S]*?\}?\}\}/g,
  liquid: /\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g,
  velocity: /#\*[\s\S]*?\*#|##[^\n]*|#\{?(?:if|else|elseif|end|foreach|set|parse|include|macro|define|break|stop)\}?(?:\([^)\n]*\))?|\$!?\{?[\w.]+(?:\([^)\n]*\))?\}?/g,
  razor: /@\*[\s\S]*?\*@|@\{[\s\S]*?\n\}|@\([^)\n]*\)|@[A-Za-z_][\w.]*(?:\([^)\n]*\))?/g,
};

const PARTIALS: Record<TemplateDialect, RegExp> = {
  handlebars: /\{\{>\s*["']?([\w/.-]+)/g,
  liquid: /\{%-?\s*(?:include|render|section)\s+["']([\w/.-]+)["']/g,
  velocity: /#(?:parse|include)\s*\(\s*["']([\w/.-]+)["']/g,
  razor: /<partial\s+name\s*=\s*["']([\w/.~-]+)["']|Html\.Partial(?:Async)?\(\s*"([\w/.~-]+)"|Html\.RenderPartial(?:Async)?\(\s*"([\w/.~-]+)"|Component\.InvokeAsync\(\s*"(\w+)"/g,
};

const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

const attr = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];

/** `{{urlpath}}/admin`, `/admin?x=1`, `@Url.Content("~/x")` stays out → `/admin`; null when not an app path. */
function literalPath(value: string | undefined): string | null {
  if (!value) return null;
  const stripped = value.replace(/^(?:\{\{[^}]*\}\}|\$\{?[\w.]+\}?)+/, "").trim();
  // `{{url}}/#/login` is a route of the client app behind a fragment, not a request to the server.
  if (/^\/?#/.test(stripped)) return null;
  const v = stripped.replace(/[?#].*$/, "");
  return v.startsWith("/") && !v.startsWith("//") ? v.replace(/\{\{[^}]*\}\}|\$\{?[\w.]+\}?/g, ":param") : null;
}

function handlerOf(method: string, target: string): string {
  const base = target.replace(/^\/|^page:\//, "").replace(/:param/g, "x").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root";
  return method === "GET" ? base : `${method.toLowerCase()}_${base}`;
}

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

  // Tag helpers and forms read on the raw text (their attributes are what blanking would erase).
  const ctlOfView = dialect === "razor" ? viewController(filePath) : null;
  for (const t of source.matchAll(/<(form|a|button)\b([^>]*)>/gi)) {
    const tag = t[1]!.toLowerCase();
    const attrs = t[2] ?? "";
    const line = lineAt(source, t.index!);
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
    if (!target || tag === "button") continue;
    const handler = handlerOf(method, target);
    elements.push({ element: isForm ? "form" : "link", event: isForm ? "submit" : "click", handler, line, request: { method, target } });
    component(target, tag, isForm ? "container" : "navigation", line, [`${isForm ? "submit" : "click"}: ${handler}`]);
    if (!isForm && method === "GET") navigatesTo.add(target);
  }

  const markup = source.replace(TAGS[dialect], (m) => m.replace(/[^\n]/g, " "));
  for (const el of extractHtmlInteractiveElements(markup.split("\n"))) {
    if ((el.element === "form" || el.element === "link") && el.handler === null) continue; // read above
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
    formType: { handlebars: "HandlebarsTemplate", liquid: "LiquidTemplate", velocity: "VelocityTemplate", razor: /(?:^|\/)Pages\//.test(filePath) ? "RazorPage" : "RazorView" }[dialect],
    caption: (caption?.[1] ?? caption?.[2])?.trim() || null,
    dimensions: null,
    components: components.sort((a, b) => a.line - b.line),
    filePath,
    routePath: dialect === "razor" ? (/^\s*@page\s+"([^"]+)"/m.exec(source)?.[1] ?? null) : null,
    navigatesTo: [...navigatesTo],
  };
  analysis.screens = [screen];
}

export const templateSpec = (dialect: TemplateDialect, extensions: string[]): RegexLangSpec => ({
  language: dialect,
  extensions,
  blockStyle: "brace",
  lineCommentPrefixes: [],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
});
