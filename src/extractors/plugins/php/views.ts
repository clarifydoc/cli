import type { FileAnalysis, FunctionInfo, ScreenComponentInfo, ScreenInfo, SubComponentInfo } from "../../../types/analysis.js";
import { extractHtmlInteractiveElements } from "../html/index.js";
import { materializeElementRequests } from "../shared/element-requests.js";

/**
 * Plain-PHP view templates — CodeIgniter's `application/views/**.php` (CI4
 * `app/Views/`), and the same shape in any framework whose views are PHP
 * mixed into HTML. The PHP parser sees only the code between the tags; the
 * page around it is what the user clicks. Read per file (`postExtract`):
 *
 *   - each PHP tag is rewritten to what it prints where a URL is concerned:
 *     `<?=base_url();?>clubs/view/<?=$club->id?>` → `/clubs/view/{{php}}`,
 *     `site_url('x')` → `/x`, `form_open('clubs/save/'.$id)` →
 *     `<form action="/clubs/save/{{php}}" method="post">`, `form_close()` →
 *     `</form>`, `anchor('clubs', 'Clubs')` → a link; any other echo is a
 *     runtime value, any other block blank. Line numbers are kept;
 *   - the HTML reader then finds the forms, submit controls and links on
 *     that markup, and the ones requesting an app path become api-calls the
 *     route linker joins (shared/element-requests.ts);
 *   - jQuery / fetch calls with a literal URL in an inline `<script>` are
 *     api-calls too, inside one pseudo-function per script block;
 *   - `$this->load->view('embeds/header')` is a sub-component;
 *   - a view that holds something to interact with, and is no partial,
 *     layout, mail or PDF body, is a screen named for its path under `views/`.
 *
 * Which controller method renders a view is a project-level join on the
 * keyed `load->view('x')` call (`CodeIgniterViewResolver`).
 */

/** `application/views/clubs/edit.php` → `clubs/edit`; null when the file is no PHP view. */
export function phpViewKey(filePath: string): string | null {
  if (/\.blade\.php$/i.test(filePath)) return null;
  return /(?:^|\/)views\/(.+)\.php$/i.exec(filePath)?.[1] ?? null;
}

/** A PHP tag: `<?=`, `<?php`, or the short `<?` (never `<?xml`). Unclosed runs to the end. */
const PHP_TAG_RE = /<\?(=|php\b|(?!xml)) ?([\s\S]*?)(?:\?>|$(?![\s\S]))/g;

const RUNTIME = "{{php}}";

/** Split `a . 'b' . c(d)` at its top-level concatenation dots. */
function concatParts(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    // A `.` between operands, not inside a number (`1.5`).
    else if (c === "." && depth === 0 && !/\d/.test(expr[i + 1] ?? "")) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A string literal's content, or null when `text` is not one literal. */
function literal(text: string): string | null {
  const m = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(text.trim());
  return m ? m[2]!.replace(/\\(.)/g, "$1") : null;
}

/** `base_url()`, `site_url('clubs')`, `base_url('x')` → the app path they print, or null. */
function urlHelper(text: string): string | null {
  const m = /^(?:base_url|site_url)\s*\(\s*(.*?)\s*\)$/.exec(text.trim());
  if (!m) return null;
  if (!m[1]) return "/";
  const arg = uriExpr(m[1]);
  return arg === null ? null : "/" + arg.replace(/^\//, "");
}

/**
 * What a PHP expression prints, as far as a URL goes: literals and URL helpers
 * as written, every other operand `{{php}}`. Null when nothing is literal.
 */
function uriExpr(expr: string): string | null {
  let out = "";
  let known = false;
  for (const part of concatParts(expr)) {
    const lit = literal(part) ?? urlHelper(part);
    if (lit !== null) {
      // `base_url() . '/clubs'` prints one slash.
      out += out.endsWith("/") && lit.startsWith("/") ? lit.slice(1) : lit;
      known = true;
    } else out += RUNTIME;
  }
  return known ? out : null;
}

/** The arguments of a call written as `name(args)`, split at top-level commas. */
function callArgs(code: string, name: RegExp): string[] | null {
  const m = new RegExp(`^(?:echo\\s+)?(?:${name.source})\\s*\\(`).exec(code);
  if (!m) return null;
  const args: string[] = [];
  let depth = 1;
  let quote: string | null = null;
  let start = m[0].length;
  for (let i = start; i < code.length; i++) {
    const c = code[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      if (--depth === 0) {
        args.push(code.slice(start, i));
        return args.map((a) => a.trim()).filter((a, k) => a || k > 0);
      }
    } else if (c === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** An app path as an attribute value: absolute URLs kept, a relative URI given its leading `/`. */
const asHref = (uri: string): string => (/^(?:[a-z]+:|\/|\{\{)/i.test(uri) ? uri : "/" + uri);

/** The markup a PHP tag stands for, given the code inside it (`=`-echo or not). */
function rewriteTag(echo: boolean, code: string): string {
  const stmt = code.trim().replace(/;\s*$/, "").trim();
  let args: string[] | null;
  if ((args = callArgs(stmt, /form_open(?:_multipart)?/))) {
    const uri = args[0] ? uriExpr(args[0]) : null;
    const method = /['"]method['"]\s*=>\s*['"]get['"]/i.test(args[1] ?? "") ? "get" : "post";
    return uri === null ? `<form method="${method}">` : `<form action="${asHref(uri)}" method="${method}">`;
  }
  if (/^(?:echo\s+)?form_close\s*\(/.test(stmt)) return "</form>";
  if ((args = callArgs(stmt, /anchor/))) {
    const uri = args[0] ? uriExpr(args[0]) : null;
    const text = (args[1] && literal(args[1])) ?? "";
    return uri === null ? "" : `<a href="${asHref(uri)}">${text.replace(/[<>]/g, "")}</a>`;
  }
  if ((args = callArgs(stmt, /form_submit/))) {
    const value = (args[1] && literal(args[1])) ?? (args[0] && literal(args[0])) ?? "";
    return `<input type="submit" value="${value.replace(/["<>]/g, "")}">`;
  }
  if (!echo && !/^(?:echo|print)\b/.test(stmt)) return "";
  const printed = stmt.replace(/^(?:echo|print)\s+/, "");
  return uriExpr(printed) ?? RUNTIME;
}

/** The view's source with every PHP tag rewritten (see file header); newlines kept 1:1. */
export function phpViewMarkup(source: string): string {
  PHP_TAG_RE.lastIndex = 0;
  return source.replace(PHP_TAG_RE, (whole, kind: string, code: string, offset: number) => {
    let out = rewriteTag(kind === "=", code);
    // `<?=base_url()?>/clubs` prints one slash.
    if (out.endsWith("/") && source[offset + whole.length] === "/") out = out.slice(0, -1);
    const newlines = whole.split("\n").length - 1;
    return out.replace(/\n/g, " ") + "\n".repeat(newlines);
  });
}

/** jQuery shorthands and `fetch` with a literal URL, and `$.ajax({ url, type })`. */
const SCRIPT_CALL_RE = /(?:\$|jQuery)\.(get|post|getJSON)\(\s*(['"])([^'"\n]+)\2(\s*\+)?|\bfetch\(\s*(['"])([^'"\n]+)\5(\s*\+)?/g;
const AJAX_RE = /(?:\$|jQuery)\.ajax\(\s*\{/g;

interface ScriptCall {
  method: string;
  target: string;
  line: number;
}

/** A script string as a route target: `{{php}}` and a `+`-appended tail are runtime segments. */
function scriptTarget(url: string, concatenated: boolean): string | null {
  let t = url.replace(/\{\{php\}\}/g, ":param");
  if (concatenated) t = t.endsWith("/") ? `${t}:param` : t;
  return t.startsWith("/") || /^https?:\/\//i.test(t) ? t : null;
}

/** The api-calls in the inline `<script>` blocks of `markup`, with each block's line span. */
function scriptCalls(markup: string): Array<{ start: number; end: number; calls: ScriptCall[] }> {
  const blocks: Array<{ start: number; end: number; calls: ScriptCall[] }> = [];
  const lineAt = (i: number): number => markup.slice(0, i).split("\n").length;
  for (const b of markup.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const bodyStart = b.index! + b[0].indexOf(">") + 1;
    const body = b[1]!;
    if (!/\$|jQuery|fetch/.test(body)) continue;
    const calls: ScriptCall[] = [];
    for (const m of body.matchAll(SCRIPT_CALL_RE)) {
      const target = m[3] !== undefined ? scriptTarget(m[3], !!m[4]) : scriptTarget(m[6]!, !!m[7]);
      if (!target) continue;
      const method = m[1] === "post" ? "POST" : "GET";
      calls.push({ method, target, line: lineAt(bodyStart + m.index!) });
    }
    for (const m of body.matchAll(AJAX_RE)) {
      const opts = body.slice(m.index!, m.index! + 600);
      const url = /\burl\s*:\s*(['"])([^'"\n]+)\1(\s*\+)?/.exec(opts);
      const target = url ? scriptTarget(url[2]!, !!url[3]) : null;
      if (!target) continue;
      const method = (/\b(?:type|method)\s*:\s*['"](\w+)['"]/.exec(opts)?.[1] ?? "GET").toUpperCase();
      calls.push({ method, target, line: lineAt(bodyStart + m.index!) });
    }
    if (calls.length > 0) blocks.push({ start: lineAt(b.index!), end: lineAt(b.index! + b[0].length), calls });
  }
  return blocks;
}

/** Directories and names whose views are pieces of a page, or no page at all. */
const NOT_A_SCREEN = /(?:^|\/)(?:_[^/]*$|embeds?\/|includes?\/|inc\/|partials?\/|layouts?\/|templates?\/|e?mails?\/|email_templates\/|pdfs?\/|errors?\/)|(?:^|\/)(?:header|footer|menu|nav|sidebar)[^/]*$/i;

const LOAD_VIEW_RE = /->\s*load\s*->\s*view\s*\(\s*(['"])([\w/.-]+)\1|\bview\s*\(\s*(['"])([\w/.-]+)\3/g;

export function readPhpView(analysis: FileAnalysis, source: string): void {
  const key = phpViewKey(analysis.filePath);
  if (key === null || !source.includes("<")) return;
  const markup = phpViewMarkup(source);
  const lines = markup.split("\n");

  const elements = extractHtmlInteractiveElements(lines, { requests: true });
  analysis.interactiveElements = elements;
  materializeElementRequests(analysis);

  // Inline scripts: one pseudo-function per block holding its calls.
  const named = new Set(analysis.functions.map((f) => f.name));
  for (const block of scriptCalls(markup)) {
    const name = `<script:${block.start}>`;
    if (!named.has(name)) {
      named.add(name);
      const fn: FunctionInfo = { name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: block.start, endLine: block.end };
      analysis.functions.push(fn);
    }
    for (const c of block.calls) analysis.dataSources.push({ kind: "api-call", name: `${c.method} ${c.target}`, target: c.target, calls: [], line: c.line });
  }

  const subComponents: SubComponentInfo[] = [];
  const components: ScreenComponentInfo[] = [];
  LOAD_VIEW_RE.lastIndex = 0;
  for (const m of source.matchAll(LOAD_VIEW_RE)) {
    const name = (m[2] ?? m[4])!.replace(/\.php$/, "");
    const line = source.slice(0, m.index).split("\n").length;
    subComponents.push({ name, importSource: null, props: [], line });
    components.push({ name, componentType: "partial", category: "container", caption: null, position: null, align: null, visible: true, children: [], events: [], dataBindings: [], line });
  }
  if (subComponents.length > 0) analysis.subComponents = subComponents;

  if (elements.length === 0 || NOT_A_SCREEN.test(key)) return;
  const navigatesTo = new Set<string>();
  for (const el of elements) {
    if (el.request && el.element === "link" && el.request.method === "GET") navigatesTo.add(el.request.target);
    components.push({
      name: el.request?.target ?? el.handler ?? el.element,
      componentType: el.element,
      category: el.element === "link" ? "navigation" : el.element === "form" ? "container" : "action",
      caption: el.caption ?? null,
      position: null,
      align: null,
      visible: true,
      children: [],
      events: [el.event + (el.handler ? ` → ${el.handler}` : "")],
      dataBindings: el.request ? [`${el.request.method} ${el.request.target}`] : [],
      line: el.line,
    });
  }
  const masked = markup.replace(/\{\{php\}\}/g, "");
  const caption = /<title[^>]*>([^<]+)<\/title>|<h1\b[^>]*>([^<]+)<\/h1>|<h2\b[^>]*>([^<]+)<\/h2>/i.exec(masked);
  const screen: ScreenInfo = {
    name: key,
    formType: "PhpView",
    caption: (caption?.[1] ?? caption?.[2] ?? caption?.[3])?.trim().replace(/\s+/g, " ") || null,
    dimensions: null,
    components: components.sort((a, b) => a.line - b.line),
    filePath: analysis.filePath,
    routePath: null,
    navigatesTo: [...navigatesTo],
  };
  analysis.screens = [screen];
}
