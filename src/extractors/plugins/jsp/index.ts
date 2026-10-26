import type {
  InteractiveElementInfo,
  ScreenComponentCategory,
  ScreenComponentInfo,
  ScreenInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { handlerOf, literalPath } from "../shared/element-requests.js";
import { attr, extractHtmlInteractiveElements, maskMarkup } from "../html/index.js";

/**
 * JSP views (`.jsp` / `.tag` fragments) — the screen tier of classic Java web
 * monoliths (Struts / Spring MVC / Spring Web Flow). A JSP under
 * `WEB-INF/views` is not URL-addressable itself (the flow/controller routes to
 * it), so unlike plain HTML pages JSPs contribute SCREENS directly rather than
 * frontend routes; the springxml plugin's web-flow definitions carry the
 * routes that reference these views.
 *
 * Three things are extracted:
 *  - plain HTML controls (forms/buttons/inputs/inline `on*=`) via the html
 *    plugin's extractor — JSPs are HTML at heart;
 *  - custom-taglib action tags (`<club:button event="approveAll">`,
 *    `<grid:actionLink event="details">`): any namespaced tag carrying an
 *    `event`/`action` attribute is an interactive element whose handler is
 *    that event name — in Web Flow apps it names the `<transition on="…">`
 *    the click fires (joined to the Java action by the webflow dispatch
 *    resolver);
 *  - `<%@ include file>` / `<jsp:include page>` → imports, tying fragments to
 *    their pages in the component graph.
 */

// A namespaced taglib tag with its attribute text; tags routinely span lines
// (`<club:button cssClass="x"\n  event="approve"/>`), so this scans the JOINED
// source, tolerating quoted `>` inside attribute values.
const TAGLIB_TAG_RE = /<([a-zA-Z][\w]*):([\w.-]+)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/g;

/** JSP taglib prefixes whose tags are structural, never user actions. */
const STRUCTURAL_PREFIXES = new Set(["jsp", "c", "fmt", "fn", "sql", "x", "spring"]);

/** Tag local-name → interactive element kind, for event-carrying taglib tags. */
const ELEMENT_BY_TAG: Array<[RegExp, InteractiveElementInfo["element"]]> = [
  [/button/i, "button"],
  [/(link|anchor|href)/i, "link"],
  [/form/i, "form"],
  [/(select|combo|dropdown|choice)/i, "select"],
  [/(textarea|textbox|text|input|field|date|check|radio)/i, "input"],
];

function elementForTag(local: string): InteractiveElementInfo["element"] {
  for (const [re, el] of ELEMENT_BY_TAG) if (re.test(local)) return el;
  return "custom";
}

/** Category a taglib control contributes to the screen's component tree. */
const CATEGORY_BY_TAG: Array<[RegExp, ScreenComponentCategory]> = [
  [/(button|actionlink|submit)/i, "action"],
  [/(textbox|text|input|select|combo|check|radio|date|field|editor|upload)/i, "input"],
  [/(grid|table|list|tree|column)/i, "data"],
  [/(menu|tab|nav|breadcrumb|wizard)/i, "navigation"],
  [/(form|page|panel|group|section|fieldset)/i, "container"],
  [/(label|message|out|text)/i, "display"],
];

function categoryForTag(local: string): ScreenComponentCategory {
  for (const [re, cat] of CATEGORY_BY_TAG) if (re.test(local)) return cat;
  return "custom";
}

interface TaglibTag {
  prefix: string;
  local: string;
  attrs: string;
  line: number;
}

/** All namespaced taglib tags in the (comment/script-masked) markup.
 *  Memoized per `lines` array — the screens and interactive-elements hooks
 *  both run on the same file within one extraction pass. */
const TAG_CACHE = new WeakMap<string[], TaglibTag[]>();

function scanTaglibTags(lines: string[]): TaglibTag[] {
  const cached = TAG_CACHE.get(lines);
  if (cached) return cached;
  const masked = maskMarkup(lines).join("\n");
  const out: TaglibTag[] = [];
  // Running newline count — matchAll yields ascending indices.
  let lastIndex = 0;
  let line = 1;
  for (const m of masked.matchAll(TAGLIB_TAG_RE)) {
    for (let i = lastIndex; i < m.index!; i++) {
      if (masked.charCodeAt(i) === 10) line++;
    }
    lastIndex = m.index!;
    out.push({ prefix: m[1]!.toLowerCase(), local: m[2]!, attrs: m[3] ?? "", line });
  }
  TAG_CACHE.set(lines, out);
  return out;
}

// ─── Interactive elements ────────────────────────────────────────────────────

/**
 * Taglib action tags: `event=` (Web Flow transition event) or `action=`
 * (Struts-style) names the handler. Bound inputs (`bindPath=`) surface as
 * elements with NO handler — they belong on the screen but resolve to nothing,
 * and a fake handler would poison the click-trace funnel's denominator.
 */
function extractJspInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const out: InteractiveElementInfo[] = [];
  for (const tag of scanTaglibTags(lines)) {
    if (STRUCTURAL_PREFIXES.has(tag.prefix)) continue;
    const event = attr(tag.attrs, "event") ?? attr(tag.attrs, "action");
    const el = elementForTag(tag.local);
    if (event) {
      out.push({
        element: el,
        event: el === "form" ? "submit" : "click",
        handler: event,
        line: tag.line,
        component: `${tag.prefix}:${tag.local}`,
      });
    } else if (attr(tag.attrs, "bindPath") ?? attr(tag.attrs, "path")) {
      if (el === "input" || el === "select" || el === "textarea") {
        out.push({ element: el, event: "input", handler: null, line: tag.line, component: `${tag.prefix}:${tag.local}` });
      }
    }
  }
  // Forms and links that request an app path: to the route linker (see `jspRequests`).
  const requests = new Map(jspRequests(lines).map((r) => [r.line, r]));
  // Plain HTML controls too — a JSP is still an HTML page.
  for (const el of extractHtmlInteractiveElements(lines)) {
    const req = (el.element === "form" || el.element === "link") ? requests.get(el.line) : undefined;
    if (req) {
      requests.delete(el.line);
      out.push({ ...el, handler: req.handler, request: { method: req.method, target: req.target } });
    } else out.push(el);
  }
  // A Web Flow event a script fires (`this.form._eventId.name='_eventId_submit'` in a listBox's
  // `onChange`, `submitEvent("_eventId_sendMail")`): an element whose handler is that event.
  const fired = new Set(out.map((e) => `${e.line}:${e.handler}`));
  lines.forEach((line, i) => {
    if (!line.includes("_eventId_")) return;
    for (const m of line.matchAll(/(["'])_eventId_([A-Za-z]\w*)\1/g)) {
      const key = `${i + 1}:${m[2]}`;
      if (fired.has(key)) continue;
      fired.add(key);
      const change = /\bon[Cc]hange\s*=/.test(line.slice(0, m.index));
      out.push({ element: /<\w+:listBox\b|<select\b/i.test(line) || change ? "select" : "custom", event: change ? "change" : "click", handler: m[2]!, line: i + 1 });
    }
  });
  // Struts/Spring form tags the HTML reader does not see (`<html:form>`, `<form:form>`).
  for (const req of requests.values()) {
    out.push({ element: req.form ? "form" : "link", event: req.form ? "submit" : "click", handler: req.handler, line: req.line, request: { method: req.method, target: req.target } });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * The server requests a JSP makes by markup: `<form action="…/x.do" method="post">`,
 * Struts `<html:form action="/x">` (an action path, served as `/x.do`) and Spring
 * `<form:form action="${ctx}/x">`, and links to an action (`<a href="/x.do?id=1">`,
 * `.action`, `.htm` — a link to a page or an asset is navigation, not a request). The
 * context-path prefix (`${pageContext.request.contextPath}`, `<c:url value="/x"/>`)
 * is dropped; a target that is not a literal app path is skipped. Each is
 * handed to the route linker like a `fetch` (`materializeElementRequests`):
 * an api-call row at the element's line inside a one-line pseudo-function
 * named after the request (`post_account_save_do`).
 */
function jspRequests(lines: string[]): Array<{ line: number; method: string; target: string; handler: string; form: boolean }> {
  const text = lines.join("\n");
  if (!/<(?:\w+:)?form\b|<a\b/i.test(text)) return [];
  const out: Array<{ line: number; method: string; target: string; handler: string; form: boolean }> = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  for (const t of text.matchAll(/<((?:html|form|s|sf):form|form|a)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const tag = t[1]!.toLowerCase();
    const form = tag !== "a";
    const attrs = t[2] ?? "";
    let raw = attr(attrs, form ? "action" : "href");
    if (!raw) continue;
    // `<c:url value="/x"/>` inside the attribute.
    raw = raw.replace(/<c:url\s+value\s*=\s*['"]([^'"]+)['"]\s*\/?>/i, "$1");
    let target = literalPath(raw);
    if (!target) continue;
    // A Struts 1 action path is served under its `.do` mapping.
    if (tag === "html:form" && !/\.\w+$/.test(target)) target += ".do";
    // A link is a request to the app only when it names an action, not a page or an asset.
    if (!form && !/\.(?:do|action|htm)$/.test(target)) continue;
    const method = (attr(attrs, "method") ?? (form ? "post" : "get")).toUpperCase();
    out.push({ line: lineAt(t.index!), method, target, handler: handlerOf(method, target), form });
  }
  return out;
}

// ─── Screens ─────────────────────────────────────────────────────────────────

/** Page caption: `<club:page labelKey="…">`-style i18n key, or the `<title>`. */
function pageCaption(lines: string[], tags: TaglibTag[]): string | null {
  const page = tags.find((t) => /^(page|view|screen|window)$/i.test(t.local));
  if (page) {
    const key = attr(page.attrs, "labelKey") ?? attr(page.attrs, "title") ?? attr(page.attrs, "label");
    if (key) return key;
  }
  const m = lines.join("\n").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1]!.trim().replace(/\s+/g, " ") || null : null;
}

function extractJspScreens(lines: string[], filePath: string): ScreenInfo[] {
  const tags = scanTaglibTags(lines);
  const base = filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.(jsp|jspx|jspf|tag)$/i, "");

  const components: ScreenComponentInfo[] = [];
  for (const tag of tags) {
    if (STRUCTURAL_PREFIXES.has(tag.prefix)) continue;
    const cat = categoryForTag(tag.local);
    if (cat === "custom") continue;
    const caption =
      attr(tag.attrs, "labelKey") ?? attr(tag.attrs, "label") ?? attr(tag.attrs, "title") ?? null;
    const name =
      attr(tag.attrs, "id") ?? attr(tag.attrs, "name") ?? attr(tag.attrs, "bindPath") ??
      attr(tag.attrs, "event") ?? tag.local;
    const events = attr(tag.attrs, "event") ? [attr(tag.attrs, "event")!] : [];
    const bind = attr(tag.attrs, "bindPath") ?? attr(tag.attrs, "path");
    components.push({
      name,
      componentType: `${tag.prefix}:${tag.local}`,
      category: cat,
      caption,
      position: null,
      align: null,
      visible: true,
      children: [],
      events,
      dataBindings: bind ? [bind] : [],
      line: tag.line,
    });
  }

  // Fragments (.tag files, header/footer includes) with no controls at all are
  // not screens — pages with markup but zero taglib controls still are.
  if (components.length === 0 && !/\.jsp$/i.test(filePath)) return [];

  return [
    {
      name: base,
      formType: "jsp-view",
      caption: pageCaption(lines, tags),
      dimensions: null,
      components,
      filePath,
      routePath: null,
      navigatesTo: [],
    },
  ];
}

// ─── Spec ────────────────────────────────────────────────────────────────────

export const jspSpec: RegexLangSpec = {
  language: "jsp",
  extensions: [".jsp", ".jspx", ".jspf", ".tag"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--", "<%--"],

  // Behaviour lives in the Java action classes the flow definitions name.
  functionPatterns: [],
  classPatterns: [],

  importPatterns: [
    {
      // `<%@ include file="../fragments/header.jsp" %>` — static include.
      pattern: /<%@\s*include\s+file\s*=\s*["']([^"']+)["']/i,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
    {
      // `<jsp:include page="x.jsp">` — runtime include.
      pattern: /<jsp:include\s+[^>]*page\s*=\s*["']([^"']+)["']/i,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractScreens: (lines, filePath) => extractJspScreens(lines, filePath),
  extractInteractiveElements: extractJspInteractiveElements,
  // Markup requests as calls the route linker joins (see `jspRequests`).
  extractDataSources: (lines) =>
    jspRequests(lines).map((r) => ({ kind: "api-call" as const, name: `${r.method} ${r.target}`, target: r.target, calls: [], line: r.line })),
  postProcessFunctions: (lines, fns) => {
    const named = new Set(fns.map((f) => f.name));
    const extra = jspRequests(lines).filter((r) => !named.has(r.handler) && named.add(r.handler));
    return [...fns, ...extra.map((r) => ({ name: r.handler, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: r.line, endLine: r.line }))];
  },
};
