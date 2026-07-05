import type { RouteInfo, InteractiveElementInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Plain HTML page extraction (regex path) — for vanilla multi-page static sites
 * (no framework, no build step: hand-written `.html` pages wired together with
 * `<a href>` links and `<script src>` includes).
 *
 * The engine's screen→API→DB model has a *screen* tier, and for a static MPA the
 * HTML pages ARE the screens. So this spec turns each page into a routed screen
 * and surfaces the wiring around it:
 *
 *  - the page itself          → ONE `frontend` route at the page's URL (its file
 *                               path); `componentPath: null` so the screen builder
 *                               treats the page as an inline screen (like Blazor
 *                               `@page`). `<a href="other.html">` links become the
 *                               screen's `navigatesTo` edges (built in core).
 *  - `<script src="./x.js">`  → imports (LOCAL only) → component-graph edges from
 *                               the page to its JS modules, so the page connects
 *                               to the JS call graph (and its `fetch` api-calls).
 *  - forms / buttons / inputs / inline `on*=` handlers → interactive elements.
 *
 * There are no functions/classes in HTML markup (the behaviour lives in the
 * `<script src>` JS files, parsed by the JS plugin), so those patterns are empty.
 */

// ─── Route (the page itself) ────────────────────────────────────────────────

/**
 * The page's route path = its project-relative URL. `index.html` represents its
 * directory (`foo/index.html` → `/foo/`, top-level → `/`); every other page maps
 * to `/<path>`. Backslashes are normalised to URL slashes.
 */
export function pageRoutePath(filePath: string): string {
  const rel = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const asDir = rel.replace(/(^|\/)index\.html?$/i, "$1");
  const path = asDir === "" ? "/" : asDir;
  return path.startsWith("/") ? path : "/" + path;
}

/** The page's `<title>` text, or null. */
function pageTitle(lines: string[]): string | null {
  const m = lines.join("\n").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, " ") || null : null;
}

function extractHtmlRoutes(lines: string[], filePath?: string): RouteInfo[] {
  if (!filePath) return [];
  return [
    {
      path: pageRoutePath(filePath),
      httpMethod: null,
      kind: "frontend",
      // The page IS the screen — no separate component file, so the screen
      // builder treats this as an inline route on the .html itself.
      componentPath: null,
      // The <title> is a friendly handle for the route; the screen caption is
      // derived from it in core too.
      handler: pageTitle(lines),
      calls: [],
      middleware: [],
      line: 1,
    },
  ];
}

// ─── Markup isolation (blank comments + inline <script>/<style> bodies) ──────

/**
 * Return a copy of `lines` with HTML comment spans and inline `<script>`/`<style>`
 * BODIES blanked, so the element scan only ever sees real page markup (a `if(x<y)`
 * in an inline script must never read as a `<y>` tag, and commented-out markup
 * must not count). Line numbers are preserved 1:1. The opening `<script …>`/`<style …>`
 * tag itself is kept (import extraction reads `src` from the raw lines separately).
 */
function maskMarkup(lines: string[]): string[] {
  const out: string[] = [];
  let inComment = false;
  let blockTag: string | null = null; // inside a <script>/<style> body
  for (const raw of lines) {
    let line = raw;

    if (blockTag) {
      const end = line.toLowerCase().indexOf("</" + blockTag);
      if (end < 0) { out.push(""); continue; }
      line = " ".repeat(end) + line.slice(end);
      blockTag = null;
    }

    // Comments (may span lines).
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) { out.push(""); continue; }
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    const open = line.indexOf("<!--");
    if (open >= 0) { line = line.slice(0, open); inComment = true; }

    // Inline <script>/<style> bodies (keep the opening tag, drop the body).
    const sb = line.match(/<(script|style)\b[^>]*>/i);
    if (sb && sb.index !== undefined) {
      const tag = sb[1].toLowerCase();
      const bodyStart = sb.index + sb[0].length;
      const closeIdx = line.toLowerCase().indexOf("</" + tag, bodyStart);
      if (closeIdx < 0) {
        line = line.slice(0, bodyStart);
        blockTag = tag;
      } else {
        line = line.slice(0, bodyStart) + line.slice(closeIdx);
      }
    }

    out.push(line);
  }
  return out;
}

// ─── Interactive elements (forms, buttons, inputs, inline handlers) ─────────

const FORM_CONTROL: Record<string, InteractiveElementInfo["element"]> = {
  form: "form",
  button: "button",
  input: "input",
  select: "select",
  textarea: "textarea",
};

/** Native event implied by an interactive control (when it carries no inline handler). */
const NATIVE_EVENT: Record<string, string> = {
  form: "submit",
  button: "click",
  input: "input",
  select: "change",
  textarea: "input",
  a: "click",
};

/** Tag → element kind for a non-control tag that carries an inline handler. */
const ELEMENT_FOR_TAG: Record<string, InteractiveElementInfo["element"]> = {
  a: "link",
  button: "button",
  form: "form",
  input: "input",
  select: "select",
  textarea: "textarea",
};

/** A `<tag ...>` opening plus the attribute text on the SAME line (stops at `>`). */
const TAG_RE = /<([a-zA-Z][\w-]*)\b([^>]*)/g;
/** Inline event handlers: `onclick="foo()"`, `onsubmit='...'`. The `\b` keeps
 *  attributes merely CONTAINING "on" out — without it, `content="notranslate"`
 *  matched as event "ontent" / handler "notranslate". */
const HANDLER_RE = /\bon([a-z]+)\s*=\s*"([^"]*)"|\bon([a-z]+)\s*=\s*'([^']*)'/gi;
/** Input types that are state/filter noise rather than meaningful actions. */
const SKIP_INPUT_TYPES = new Set(["checkbox", "radio", "hidden"]);

/** Pull a clean handler name from an inline-handler value: a call wins, then a
 *  bare member path; lambdas/expressions fall back to null. */
function cleanHandler(raw: string): string | null {
  const val = raw.trim();
  const call = val.match(/([A-Za-z_$][\w$]*)\s*\(/);
  if (call) return call[1]!;
  const ident = val.match(/^([A-Za-z_$][\w$.]*)$/);
  if (ident) return ident[1]!;
  return null;
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function extractHtmlInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const markup = maskMarkup(lines);
  const out: InteractiveElementInfo[] = [];
  for (let i = 0; i < markup.length; i++) {
    const ln = i + 1;
    for (const m of markup[i]!.matchAll(TAG_RE)) {
      const tag = m[1]!.toLowerCase();
      const attrs = m[2] ?? "";
      const handlers = [...attrs.matchAll(HANDLER_RE)];
      const inline = handlers[0]
        ? { event: "on" + (handlers[0][1] ?? handlers[0][3])!.toLowerCase(), handler: cleanHandler((handlers[0][2] ?? handlers[0][4])!) }
        : null;
      const control = FORM_CONTROL[tag];

      if (control) {
        // Skip checkbox/radio/hidden inputs — filter/state noise, not actions.
        if (tag === "input") {
          const type = (attr(attrs, "type") ?? "text").toLowerCase();
          if (SKIP_INPUT_TYPES.has(type)) continue;
          // A submit/button/reset input is really a button.
          if (type === "submit" || type === "button" || type === "reset") {
            out.push({ element: "button", event: inline?.event ?? "click", handler: inline?.handler ?? attr(attrs, "id"), line: ln });
            continue;
          }
        }
        out.push({
          element: control,
          event: inline?.event ?? NATIVE_EVENT[tag] ?? "click",
          handler: inline?.handler ?? attr(attrs, "id"),
          line: ln,
        });
      } else if (inline) {
        // A non-control element (a/span/div/li…) carrying an inline handler.
        out.push({
          element: ELEMENT_FOR_TAG[tag] ?? "custom",
          event: inline.event,
          handler: inline.handler,
          line: ln,
        });
      }
    }
  }
  return out;
}

// ─── Spec ───────────────────────────────────────────────────────────────────

export const htmlSpec: RegexLangSpec = {
  language: "html",
  extensions: [".html", ".htm"],
  blockStyle: "brace",
  lineCommentPrefixes: ["<!--"],

  // Behaviour lives in the `<script src>` JS files (parsed by the JS plugin).
  functionPatterns: [],
  classPatterns: [],

  importPatterns: [
    {
      // LOCAL `<script src="./x.js">` only — CDN/absolute URLs aren't project
      // files. Ties the page to its JS modules in the import/component graph.
      pattern: /<script\b[^>]*\bsrc\s*=\s*["'](?!https?:|\/\/)([^"']+\.[cm]?js)["']/i,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractRoutes: (lines, _classes, filePath) => extractHtmlRoutes(lines, filePath),
  extractInteractiveElements: (lines) => extractHtmlInteractiveElements(lines),
};
