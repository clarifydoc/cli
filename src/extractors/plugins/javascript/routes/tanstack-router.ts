import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/**
 * TanStack Router, both ways it declares routes.
 *
 * File routes name their own full path: `createFileRoute("/posts/$postId")({
 * component: Post })` in `routes/posts.$postId.tsx` — the generator writes the
 * same string from the file name, so the call is the fact and the file name
 * is not re-derived. `createLazyFileRoute` is the code-split half of the same
 * route.
 *
 * Code routes name a path relative to a parent: `createRoute({
 * getParentRoute: () => usersRoute, path: "$userId", component: User })`.
 * The full path is the chain of parents in the file, up to a
 * `createRootRoute()`; a route whose parent is not declared in the same file
 * is left out rather than guessed at.
 *
 * Path syntax: `$name` is a parameter (`:name`), a lone `$` the splat (`*`),
 * a segment starting with `_` a pathless layout, `(group)` a folder that adds
 * nothing, `{-$name}` an optional parameter, and a trailing `/` the index.
 */

const FILE_ROUTE_FNS = new Set(["createFileRoute", "createLazyFileRoute"]);
const ROOT_FNS = new Set(["createRootRoute", "createRootRouteWithContext"]);

/** A TanStack path as the route map writes paths: `/posts/:postId`, `/files/*`. */
export function tanstackPath(raw: string): string {
  const segs: string[] = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg.startsWith("_") || /^\(.*\)$/.test(seg)) continue;
    const optional = /^\{-\$(\w+)\}$/.exec(seg);
    if (optional) segs.push(`:${optional[1]}?`);
    else if (seg === "$") segs.push("*");
    else if (seg.startsWith("$")) segs.push(`:${seg.slice(1)}`);
    else segs.push(seg);
  }
  return "/" + segs.join("/");
}

/** Whether a path's last written segment is a pathless layout (`/_auth`): a layout, not a page of its own. */
function isLayoutOnly(raw: string): boolean {
  const last = raw.split("/").filter(Boolean).pop();
  return !!last && (last.startsWith("_") || /^\(.*\)$/.test(last));
}

function calleeName(call: Node): string | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  // `createRootRouteWithContext<Ctx>()(...)`: the inner call names the function.
  if (fn.type === "call_expression") return calleeName(fn);
  return null;
}

function firstArg(call: Node): Node | null {
  return call.childForFieldName("arguments")?.namedChildren[0] ?? null;
}

function prop(obj: Node, key: string): Node | null {
  for (const p of obj.namedChildren) {
    if (p.type !== "pair") continue;
    const k = p.childForFieldName("key");
    if (k && stripQuotes(k.text) === key) return p.childForFieldName("value");
  }
  return null;
}

/**
 * The page a route renders, as `componentPath` carries it: a component name,
 * or the module of `lazyRouteComponent(() => import("./x"))`. Null for an
 * inline arrow (`component: () => <Outlet />`) — the route file is the screen.
 */
function componentOf(options: Node | null): string | null {
  const c = options && options.type === "object" ? prop(options, "component") : null;
  if (!c) return null;
  if (c.type === "identifier" && /^[A-Z]/.test(c.text)) return c.text;
  if (c.type === "call_expression" && calleeName(c) === "lazyRouteComponent") {
    const m = /import\(\s*(['"`])([^'"`]+)\1\s*\)/.exec(c.text);
    if (m) return m[2]!;
  }
  return null;
}

/** Whether `obj` is the options object of a TanStack `createRoute(...)` — paths there are relative, so the generic route-config visitor must not read it. */
export function isTanstackRouteOptions(obj: Node): boolean {
  const args = obj.parent;
  const call = args?.parent;
  return args?.type === "arguments" && call?.type === "call_expression" && calleeName(call) === "createRoute";
}

/** Per-node visitor for file routes, run in the shared JS route walk. */
export function visitTanstackFileRoute(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "call_expression") return;
  const inner = node.childForFieldName("function");
  if (inner?.type !== "call_expression") return;
  const fn = inner.childForFieldName("function");
  if (fn?.type !== "identifier" || !FILE_ROUTE_FNS.has(fn.text)) return;
  const pathNode = firstArg(inner);
  if (!pathNode || (pathNode.type !== "string" && pathNode.type !== "template_string")) return;
  const raw = stripQuotes(pathNode.text);
  if (!raw.startsWith("/") || raw.includes("${") || isLayoutOnly(raw)) return;
  const component = componentOf(firstArg(node));
  routes.push({
    path: tanstackPath(raw),
    httpMethod: null,
    kind: "frontend",
    handler: component && !component.includes("/") ? component : "",
    componentPath: component,
    calls: [],
    middleware: [],
    line: node.startPosition.row + 1,
  });
}

interface CodeRoute {
  name: string;
  parent: string | null;
  /** The path as written, or null for a pathless (`id:`) route. */
  path: string | null;
  component: string | null;
  line: number;
  root: boolean;
}

/** File-level pass for code routes: every `const x = createRoute({...})`, joined up its parents. */
export function collectTanstackCodeRoutes(root: Node, sourceText: string, routes: RouteInfo[]): void {
  if (!sourceText.includes("createRoute(")) return;
  const byName = new Map<string, CodeRoute>();
  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      if (name?.type === "identifier" && value?.type === "call_expression") {
        const fn = calleeName(value);
        if (fn && ROOT_FNS.has(fn)) {
          byName.set(name.text, { name: name.text, parent: null, path: "", component: null, line: n.startPosition.row + 1, root: true });
        } else if (fn === "createRoute") {
          const opts = firstArg(value);
          if (opts?.type === "object") {
            const parentFn = prop(opts, "getParentRoute");
            const body = parentFn?.type === "arrow_function" ? parentFn.childForFieldName("body") : null;
            const pathNode = prop(opts, "path");
            byName.set(name.text, {
              name: name.text,
              parent: body?.type === "identifier" ? body.text : null,
              path: pathNode && pathNode.type === "string" ? stripQuotes(pathNode.text) : null,
              component: componentOf(opts),
              line: value.startPosition.row + 1,
              root: false,
            });
          }
        }
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);

  // The full written path of a route, or null when its chain leaves the file.
  const memo = new Map<string, string | null>();
  const full = (r: CodeRoute, depth = 0): string | null => {
    if (r.root) return "";
    if (memo.has(r.name)) return memo.get(r.name)!;
    const parent = r.parent ? byName.get(r.parent) : undefined;
    const base = parent && depth < 32 ? full(parent, depth + 1) : null;
    const own = r.path === null ? "" : r.path.replace(/^\/+|\/+$/g, "");
    const out = base === null ? null : own ? `${base}/${own}` : base;
    memo.set(r.name, out);
    return out;
  };
  const parents = new Set([...byName.values()].map((r) => r.parent).filter(Boolean));
  for (const r of byName.values()) {
    if (r.root || r.path === null) continue; // a pathless layout renders its children's pages
    // A path with children and no component of its own is a layout (an `<Outlet />`), not a page.
    if (!r.component && parents.has(r.name)) continue;
    const p = full(r);
    if (p === null) continue;
    routes.push({
      path: tanstackPath(p || "/"),
      httpMethod: null,
      kind: "frontend",
      handler: r.component && !r.component.includes("/") ? r.component : "",
      componentPath: r.component,
      calls: [],
      middleware: [],
      line: r.line,
    });
  }
}
