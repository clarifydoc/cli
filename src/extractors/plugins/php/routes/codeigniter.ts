import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo, Language, RouteParamBinding, RouteParamInfo } from "../../../../types/analysis.js";
import type { RouteExtractor } from "../../../routes/base.js";
import { route } from "../../../routes/base.js";
import { findChildByType } from "../../../shared/node-helpers.js";
import { extractCalls } from "../../../shared/call-graph.js";
import { applyRouteMeta } from "../../../shared/route-metadata.js";

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
 * signature parameter binds from the route (inferred — the path template
 * never spells them). What the body reads through the input class is
 * appended: `$this->input->post('x')` → form, `->get('x')` → query,
 * CI4 `$this->request->getJSON()` / `getVar('x')` → body,
 * `getHeaderLine('X')` → header. CI has no auth layer of its own, so `auth`
 * stays absent.
 */

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
function controllerBase(filePath: string): string | null {
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

  extractRoutes(tree: Tree, _sourceText: string, filePath?: string): RouteInfo[] {
    if (!filePath) return [];
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
        routes.push(
          applyRouteMeta(
            route({
              path,
              httpMethod: null, // CI dispatches all HTTP verbs to one URI
              kind: "api",
              handler: name,
              line: member.startPosition.row + 1,
              calls: mbody ? extractCalls(mbody, "php") : [],
            }),
            { params: ciParams(member, mbody) },
          ),
        );
      }
    }

    return routes;
  },
};
