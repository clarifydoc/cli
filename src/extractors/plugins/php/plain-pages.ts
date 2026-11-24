import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import { handlerOf } from "../shared/element-requests.js";
import { extractCalls } from "../../shared/call-graph.js";

/**
 * Plain PHP pages: a classic site's `clubs.php`, `admin/edit_player.php`, `save_club.php` — scripts
 * served at their own path, outside any framework's views or controllers.
 *
 *   - a script is a page when the markup around its PHP tags holds a form, a link or an inline script
 *     (read like a view: `views.ts`); relative `action`/`href`/`fetch` targets naming a `.php` are
 *     resolved against the page's own directory, so `../players.php?id=3` from `admin/edit.php`
 *     requests `/players.php`;
 *   - a script that reads `$_POST` / `$_GET` / `$_REQUEST` / `php://input`, or a page, is a route at
 *     its own path (under a document-root directory — `public/`, `htdocs/`, `www/` — when it sits in
 *     one): `$_POST` → POST, `$_GET` → GET, `$_REQUEST` both, `php://input` POST; a page also answers GET;
 *   - a `<form method="post">` with no `action`, or one whose action prints `$_SERVER['PHP_SELF']`,
 *     posts to the page's own route (`ScreenInfo.renderedBy`).
 *
 * Never a route or page: a file declaring a class, interface, trait or namespace (a library), a file
 * in a library, framework or test directory (`vendor/`, `lib/`, `includes/`, `app/`, `src/`, `tests/` …),
 * a framework's front controller, a script that reads no request input and shows no page.
 */

/** Directories whose scripts are libraries, framework code or tests: never served pages. */
const NOT_SERVED = /(?:^|\/)(?:vendor|node_modules|lib|libs|library|libraries|include|includes|inc|classes|class|src|config|configs|bootstrap|storage|tests?|spec|database|migrations?|resources|cache|logs?|views?)\//i;

/** A script that is a piece of a page (`header.php`, `_nav.php`): included by pages, never served on its own. */
const PARTIAL = /(?:^|\/)(?:_[^/]*|(?:header|footer|menu|nav|navbar|sidebar|layout)[^/]*)\.php$/i;

/** A file that is a framework's entry or bootstrap, not one page of a site. */
const FRONT_CONTROLLER = /vendor\/autoload\.php|bootstrap\/app\.php|->handleRequest\(|->handle\(\s*\$request|\bKernel\b|->run\(\s*\)/;

/** Document-root directories: a script in one is served without the directory. */
const DOC_ROOT = /^(?:.*?\/)?(?:public|public_html|htdocs|www|wwwroot|webroot)\//i;

/** `site/public/admin/edit.php` → `/admin/edit.php`; null for a file no web server would serve as a page. */
export function plainPagePath(filePath: string): string | null {
  if (!/\.php$/i.test(filePath) || /\.blade\.php$/i.test(filePath) || PARTIAL.test(filePath)) return null;
  if (NOT_SERVED.test(filePath.replace(/[^/]+$/, ""))) return null;
  return "/" + filePath.replace(DOC_ROOT, "");
}

const PHP_TAGS = /<\?(?:=|php\b|(?!xml))[\s\S]*?(?:\?>|$(?![\s\S]))/g;

/**
 * The path a script is served at, or null when it is no served script: a library (declares a class,
 * interface, trait or namespace), a framework's front controller (judged on its PHP, not its prose).
 * One gate for the page and the route, so a screen never names a route that does not exist.
 */
export function servedScriptPath(filePath: string, source: string): string | null {
  const path = plainPagePath(filePath);
  if (path === null) return null;
  const code = [...source.matchAll(PHP_TAGS)].map((m) => m[0]).join("\n");
  if (/^[^\S\r\n\u2028\u2029]*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|namespace)\s+\w/m.test(code)) return null;
  return FRONT_CONTROLLER.test(code) ? null : path;
}

/** True when the markup around the PHP tags holds a form, a link or an inline script. */
export function hasPageMarkup(source: string): boolean {
  if (!source.includes("<")) return false;
  const html = source.replace(PHP_TAGS, " ");
  return /<form\b|<a\s[^>]*\bhref\s*=|<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?(?:\$|jQuery|fetch)/i.test(html);
}

/** Resolve `value` against the directory of `pagePath`; null when it escapes the root. */
function resolveRelative(pagePath: string, value: string): string | null {
  const dir = pagePath.replace(/[^/]*$/, "").split("/").filter(Boolean);
  for (const seg of value.split("/")) {
    if (seg === "..") {
      if (dir.length === 0) return null;
      dir.pop();
    } else if (seg !== "." && seg !== "") dir.push(seg);
  }
  return "/" + dir.join("/");
}

/** A relative target naming a `.php` script (`save.php`, `../players.php?id=3`), as an absolute app path; else null. */
export function resolvePageTarget(pagePath: string, value: string): string | null {
  const v = value.trim();
  if (!v || /^(?:[a-z][a-z0-9+.-]*:|\/|#|\?|\{\{)/i.test(v)) return null;
  const m = /^([^?#]*\.php)([?#].*)?$/i.exec(v);
  if (!m) return null;
  const path = resolveRelative(pagePath, m[1]!);
  return path === null ? null : path + (m[2] ?? "");
}

/** Rewrite relative `.php` targets of `action`/`href`/`formaction` attributes to absolute app paths. */
export function resolveMarkupTargets(markup: string, pagePath: string): string {
  return markup.replace(/(\b(?:action|href|formaction)\s*=\s*)(["'])([^"'\n]*)\2/gi, (whole, lead: string, q: string, value: string) => {
    const abs = resolvePageTarget(pagePath, value);
    return abs === null ? whole : `${lead}${q}${abs}${q}`;
  });
}

/** An expression printing the page's own address, which an `action` echoes to post back to the page. */
export const SELF_ADDRESS = /^(?:(?:htmlspecialchars|htmlentities|esc_url|strip_tags)\s*\(\s*)?\$_SERVER\s*\[\s*['"](?:PHP_SELF|SCRIPT_NAME|REQUEST_URI)['"]\s*\]\s*(?:,[^)]*)?\)?$/;

interface RequestReads {
  get: boolean;
  post: boolean;
  request: boolean;
  input: boolean;
}

/** The request inputs a script reads (variables, not text: a comment naming `$_POST` reads nothing). */
function requestReads(root: Node): RequestReads {
  const out: RequestReads = { get: false, post: false, request: false, input: false };
  for (const v of root.descendantsOfType("variable_name")) {
    switch (v?.text) {
      case "$_GET": out.get = true; break;
      case "$_POST": case "$_FILES": out.post = true; break;
      case "$_REQUEST": out.request = true; break;
    }
  }
  for (const n of root.descendantsOfType("name")) {
    if (n?.text === "INPUT_POST") out.post = true;
    else if (n?.text === "INPUT_GET") out.get = true;
  }
  for (const s of root.descendantsOfType(["string", "encapsed_string"])) {
    if (s && /php:\/\/input/.test(s.text)) out.input = true;
  }
  return out;
}

/** Does the file declare a class-like or a namespace (a library, a framework class)? */
function declaresTypes(root: Node): boolean {
  return root.namedChildren.some((c) => c && /^(?:class|interface|trait|enum)_declaration$|^namespace_definition$/.test(c.type));
}

/**
 * The routes of a plain page, one per verb it answers, at its own path. A page (markup holding
 * something to interact with) also answers GET.
 */
export function plainPageRoutes(root: Node, sourceText: string, filePath: string): RouteInfo[] {
  const path = servedScriptPath(filePath, sourceText);
  if (path === null || declaresTypes(root)) return [];
  const reads = requestReads(root);
  const page = hasPageMarkup(sourceText);
  const methods = new Set<string>();
  if (reads.get || reads.request || page) methods.add("GET");
  if (reads.post || reads.request || reads.input) methods.add("POST");
  if (methods.size === 0) return [];
  return [...methods].map((httpMethod) => ({
    path,
    httpMethod,
    kind: "api" as const,
    handler: null,
    calls: extractCalls(root, "php"),
    middleware: [],
    line: 1,
  }));
}

/** Give a page's screen its own route and the render link a self-posting form needs. */
export function bindPageScreen(analysis: FileAnalysis, path: string): void {
  for (const screen of analysis.screens ?? []) {
    screen.routePath = path;
    screen.renderedBy = [{ filePath: analysis.filePath, method: "GET", path, line: 1 }];
  }
}

/**
 * A self-posting form's request is built by core once the page's route is known, under the handler
 * name `handlerOf("POST", path)`; the symbol link it yields starts at that function, so the page
 * declares it (a one-line pseudo-function at the first such control) like a form with an action does.
 */
export function declareSelfPostHandler(analysis: FileAnalysis, path: string): void {
  const own = analysis.interactiveElements.find((e) => e.ownViewPost && !e.request);
  if (!own) return;
  const name = handlerOf("POST", path);
  if (analysis.functions.some((f) => f.name === name)) return;
  analysis.functions.push({ name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line: own.line, endLine: own.line });
}
