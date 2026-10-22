import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo, Language, RouteParamBinding, RouteParamInfo, RouteFact } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { route } from "../../../routes/base.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta, type GuardAttr } from "../../../shared/route-metadata.js";

/**
 * CodeIgniter convention-based routing.
 *
 * CodeIgniter (and JaRocka, its derivative used by photo-booth) maps a URL
 * directly onto a controller file + public method, with NO route table:
 *
 *   application/controllers/api/photos.php  →  class Photos
 *     public function archive()             →  /api/photos/archive
 *     public function index()               →  /api/photos
 *
 * The URL's controller segment is the file's basename (the class name is its
 * Ucfirst form, so the file name is the canonical URL token); the directory
 * under `controllers/` becomes a URL prefix. CodeIgniter dispatches *every*
 * HTTP verb to the same URI, so routes carry no method — the cross-tier linker
 * treats a null method as a wildcard.
 *
 * This is the half of the screen→API→DB chain the engine was missing for CI:
 * without it, every Vue `fetch('/checkout/verify')` had no backend route to
 * join to, so `apiRouteLinks` was empty and traces dead-ended in the frontend.
 *
 * Routing is purely path-driven, so the extractor needs the file path; files
 * outside a `controllers/` directory produce nothing.
 *
 * Parameters: CI passes the URI segments after the method name as the
 * method's arguments (`/photos/archive/5` → `archive($id)`), so every
 * signature parameter binds from the route (inferred). The path stays the
 * method's own; each run of segments the signature binds is an alias
 * (`/api/photos/archive/{id}`), so a call that carries an id joins the one
 * route. What the body reads through the input class is appended:
 * `$this->input->post('x')` → form, `->get('x')` → query, CI4
 * `$this->request->getJSON()` / `getVar('x')` → body, `getHeaderLine('X')`
 * → header.
 *
 * Auth: CI has no auth layer of its own, but an app guards a whole
 * controller from its constructor — `$this->is_logged_in()` there runs
 * before every method — so a login/permission check the constructor calls
 * is each route's guard.
 *
 * `config/routes.php` remaps URIs onto controllers
 * (`$route['clubs'] = 'club/list'`): each entry is a `ci:route` fact, which
 * `codeigniterRoutesResolver` turns into an alias of the route it names.
 */

export const CI_ROUTE_FACT = "ci:route";
/** A file that declares `Route::` facade routes: its sub-project is Laravel's, whatever its folders are called. */
export const LARAVEL_ROUTES_FACT = "laravel:routes";

/** One `$route['from'] = 'to'` entry: both as written, `(:any)` / `(:num)` / `$1` kept. */
export interface CiRouteAlias {
  from: string;
  to: string;
}

/** `$route['clubs/(:num)'] = "club/view/$1";` — the reserved keys configure, they do not alias. */
const ROUTES_ENTRY_RE = /^[ \t]*\$route\[\s*(['"])([^'"]+)\1\s*\]\s*=\s*(['"])([^'"]+)\3\s*;/gm;
const RESERVED_ROUTE_KEYS = new Set(["default_controller", "404_override", "translate_uri_dashes"]);

function extractRouteTable(sourceText: string, facts: RouteFact[]): void {
  for (const m of sourceText.matchAll(ROUTES_ENTRY_RE)) {
    if (RESERVED_ROUTE_KEYS.has(m[2]!)) continue;
    const line = sourceText.slice(0, m.index).split("\n").length;
    facts.push({ kind: CI_ROUTE_FACT, line, data: { from: m[2]!, to: m[4]! } satisfies CiRouteAlias });
  }
}

/** A method name that checks the caller in: `is_logged_in`, `require_login`, `check_permission`, `authenticate`. */
const GUARD_NAME_RE = /logged_?in|login|auth|permission|access|admin_only|restrict/i;

/** The guards a controller's constructor (`__construct` or the PHP4 class-named one) calls on itself. */
function constructorGuards(cls: Node, className: string): GuardAttr[] {
  const body = cls.childForFieldName("body") ?? findChildByType(cls, "declaration_list");
  const ctor = body?.children.find((m) => m.type === "method_declaration" && /^(?:__construct)$/i.test(m.childForFieldName("name")?.text ?? "")
    || (m.type === "method_declaration" && (m.childForFieldName("name")?.text ?? "").toLowerCase() === className));
  const ctorBody = ctor?.childForFieldName("body");
  if (!ctorBody) return [];
  const out: GuardAttr[] = [];
  const walk = (n: Node): void => {
    let name: string | undefined;
    if (n.type === "member_call_expression" && n.childForFieldName("object")?.text === "$this") name = n.childForFieldName("name")?.text;
    else if (n.type === "function_call_expression" && n.childForFieldName("function")?.type === "name") name = n.childForFieldName("function")?.text;
    if (name && GUARD_NAME_RE.test(name) && !out.some((g) => g.text === name)) out.push({ text: name });
    for (const c of n.namedChildren) walk(c);
  };
  walk(ctorBody);
  return out;
}

/**
 * Each run of leading signature parameters as further URI segments:
 * `/a/b/{id}`, `/a/b/{id}/{page}`. `index` takes them only after its own
 * name (`/a/index/{page}` — `/a/5` asks for a method `5`), and answers at
 * `/a/index` too.
 */
function segmentAliases(path: string, params: RouteParamInfo[], isIndex: boolean): string[] {
  const base = isIndex ? `${path}/index` : path;
  const out = isIndex ? [base] : [];
  let tail = "";
  for (const p of params) {
    if (p.binding !== "route") continue;
    tail += `/{${p.name}}`;
    out.push(base + tail);
  }
  return out;
}

/** CI3 `$this->input->…` and CI4 `$this->request->…` accessors, with the binding each reads. */
const INPUT_ACCESSORS: ReadonlyArray<[RegExp, RouteParamBinding, string | null]> = [
  [/\$this->input->post\(\s*(['"])([^'"]+)\1/g, "form", null],
  [/\$this->input->get\(\s*(['"])([^'"]+)\1/g, "query", null],
  [/\$this->input->get_post\(\s*(['"])([^'"]+)\1/g, "query", null],
  [/\$this->input->post_get\(\s*(['"])([^'"]+)\1/g, "form", null],
  [/\$this->input->get_request_header\(\s*(['"])([^'"]+)\1/g, "header", null],
  [/\$this->request->getPost\(\s*(['"])([^'"]+)\1/g, "form", null],
  [/\$this->request->getGet\(\s*(['"])([^'"]+)\1/g, "query", null],
  [/\$this->request->getVar\(\s*(['"])([^'"]+)\1/g, "body", null],
  [/\$this->request->getJsonVar\(\s*(['"])([^'"]+)\1/g, "body", null],
  [/\$this->request->getHeaderLine\(\s*(['"])([^'"]+)\1/g, "header", null],
  [/\$this->request->getFile\(\s*(['"])([^'"]+)\1/g, "form", "UploadedFile"],
];

/** Signature params (URI segments → route) plus what the body reads through the input class. */
function ciParams(method: Node, body: Node | null): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const push = (p: RouteParamInfo): void => {
    const key = `${p.binding}:${p.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const formal = method.childForFieldName("parameters") ?? findChildByType(method, "formal_parameters");
  for (const p of formal?.children ?? []) {
    if (p.type !== "simple_parameter" && p.type !== "variadic_parameter") continue;
    const name = findChildByType(p, "variable_name")?.text.replace(/^\$/, "");
    if (!name) continue;
    const typeNode = p.children.find((c) => /_type$/.test(c.type));
    const type = typeNode ? typeNode.text.replace(/^\?/, "").replace(/.*\\/, "") : null;
    push({ name, type, binding: "route", inferred: true });
  }
  if (!body) return out;
  const text = body.text;
  if (!text.includes("$this->input->") && !text.includes("$this->request->")) return out;
  for (const [re, binding, type] of INPUT_ACCESSORS) {
    for (const m of text.matchAll(re)) push({ name: m[2]!, type, binding, inferred: true });
  }
  if (/\$this->request->(?:getJSON|getRawInput|getBody)\(/.test(text) || /\$this->input->raw_input_stream\b/.test(text)) {
    push({ name: "body", type: null, binding: "body", inferred: true });
  }
  if (/\$this->input->post\(\s*\)/.test(text)) push({ name: "body", type: null, binding: "form", inferred: true });
  return out;
}

// PHP magic + lifecycle methods CodeIgniter never exposes as a URL segment.
const NON_ROUTE_METHODS: ReadonlySet<string> = new Set<string>([
  "__construct", "__destruct", "__get", "__set", "__isset", "__unset",
  "__call", "__callstatic", "__sleep", "__wakeup", "__tostring",
  "__invoke", "__clone", "__debuginfo",
]);

/** `application/controllers/api/photos.php` → `api/photos`; null if not a controller. */
export function controllerBase(filePath: string): string | null {
  const posix = filePath.replace(/\\/g, "/");
  // Laravel controllers live under `app/Http/Controllers/` — routed by the
  // `Route::` facade, not by CI's URL-from-path convention. Without this veto
  // every Laravel controller minted phantom `/usercontroller/...` routes.
  if (/\/Http\/Controllers\//i.test(posix)) return null;
  const m = posix.match(/(?:^|\/)controllers\/(.+)\.php$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

/** A method is routable unless explicitly `private`/`protected`. */
function isPublicMethod(method: Node): boolean {
  for (const c of method.children) {
    if (c.type === "visibility_modifier") {
      return c.text.toLowerCase() === "public";
    }
  }
  return true; // PHP default visibility is public
}

function collectClassDeclarations(node: Node, out: Node[]): void {
  if (
    node.type === "class_declaration" ||
    node.type === "trait_declaration"
  ) {
    out.push(node);
  }
  for (const child of node.children) collectClassDeclarations(child, out);
}

export const codeigniterRouteExtractor: RouteExtractor = {
  languages: ["php"] as Language[],

  extractRoutes(tree: Tree, sourceText: string, filePath?: string, facts?: RouteFact[]): RouteInfo[] {
    if (!filePath) return [];
    if (facts && /(?:^|\/)config\/routes\.php$/i.test(filePath) && sourceText.includes("$route[")) extractRouteTable(sourceText, facts);
    const base = controllerBase(filePath);
    if (!base) return [];

    const routes: RouteInfo[] = [];
    const classes: Node[] = [];
    collectClassDeclarations(tree.rootNode, classes);

    for (const cls of classes) {
      const className = (cls.childForFieldName("name")?.text ?? "").toLowerCase();
      const body =
        cls.childForFieldName("body") ?? findChildByType(cls, "declaration_list");
      if (!body) continue;
      const guards = constructorGuards(cls, className);

      for (const member of body.children) {
        if (member.type !== "method_declaration") continue;
        if (!isPublicMethod(member)) continue;

        const name = member.childForFieldName("name")?.text;
        if (!name) continue;
        const lower = name.toLowerCase();
        if (NON_ROUTE_METHODS.has(lower)) continue;
        if (name.startsWith("_")) continue; // CI never routes _-prefixed methods
        if (lower === className) continue; // PHP4-style constructor, not a route

        const path = lower === "index" ? `/${base}` : `/${base}/${name}`;
        const mbody = member.childForFieldName("body");
        const params = ciParams(member, mbody);
        const r = applyRouteMeta(
          route({
            path,
            httpMethod: null, // CI dispatches all HTTP verbs to one URI
            kind: "api",
            handler: name,
            line: member.startPosition.row + 1,
            calls: mbody ? extractCalls(mbody, "php") : [],
          }),
          { params, inheritedGuards: guards },
        );
        const aliases = segmentAliases(path, params, lower === "index");
        if (aliases.length > 0) r.aliases = aliases;
        routes.push(r);
      }
    }

    return routes;
  },
};
