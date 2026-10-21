import type { Node, Tree } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { componentOf, redirectTargetOf } from "./react-router.js";
import { isTanstackRouteOptions } from "./tanstack-router.js";

/** Vue Router: routes array config { path: "/foo", component: Bar } */
export function extractVueRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForVueRouterConfig(root, routes);
}

function walkForVueRouterConfig(node: Node, routes: RouteInfo[]) {
  visitVueRouterRoute(node, routes);
  for (const child of node.children) {
    walkForVueRouterConfig(child, routes);
  }
}

/**
 * Route-config keys that distinguish a router entry from an arbitrary object
 * that merely HAS a `path` property. Data arrays are full of the latter —
 * category descriptors (`{ text: "Vegetables", path: "Vegetables", image }`),
 * sidebar link lists (`{ name, path, icon }`) — and each one became a phantom
 * frontend route. A real SPA-router record renders/forwards something, so it
 * carries at least one of these.
 *
 * Covers Vue Router (`component`/`redirect`/`beforeEnter`), Angular Router
 * (`loadComponent`/`loadChildren`/`redirectTo`/`canActivate`) AND React
 * Router's data routers (`createBrowserRouter`, `useRoutes`: `element`,
 * `Component`, `lazy`) — all `{ path, … }[]` config arrays, so one object
 * visitor handles them with no risk of double-emitting the shared shape.
 * The React keys count only with a value of their shape (see
 * {@link isRouteRecord}): `element` is JSX, `Component` a component name.
 */
const ROUTE_CONFIG_KEYS = new Set([
  "component", "components", "redirect", "beforeEnter",
  "loadComponent", "loadChildren", "redirectTo", "canActivate",
  "element", "Component", "lazy",
]);

/** `element={<Page />}`'s object form: JSX, possibly parenthesized. */
function isJsxValue(value: Node): boolean {
  const v = value.type === "parenthesized_expression" ? value.namedChildren[0] : value;
  return v?.type === "jsx_element" || v?.type === "jsx_self_closing_element";
}

/** Whether a route-config key's value has the shape that key takes in a router. */
function keyCounts(key: string, value: Node): boolean {
  if (key === "component" || key === "components") return !NON_COMPONENT_VALUES.has(value.type);
  if (key === "element") return isJsxValue(value);
  if (key === "Component") return value.type === "identifier" && /^[A-Z]/.test(value.text);
  if (key === "lazy") return /import\(/.test(value.text) && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function");
  return true;
}

/** Literal values a real `component` never has: `{ component: "Button" }` is a docs or data entry. */
const NON_COMPONENT_VALUES = new Set(["string", "number", "true", "false", "null", "undefined", "object", "array"]);

/** The property value of `key` in an object literal. */
function propValue(obj: Node, key: string): Node | null {
  for (const prop of obj.namedChildren) {
    if (prop.type !== "pair" && prop.type !== "property_assignment") continue;
    if (prop.childForFieldName("key")?.text === key) return prop.childForFieldName("value");
  }
  return null;
}

/**
 * Whether an object is a router record: it renders or forwards something
 * (see {@link ROUTE_CONFIG_KEYS}), or it is a component-less parent whose
 * `children` are router records (Angular `{ path: "admin", children: [...] }`).
 * A `children` array alone is every tree-shaped data structure.
 */
export function isRouteRecord(obj: Node, depth = 0): boolean {
  for (const key of ROUTE_CONFIG_KEYS) {
    const value = propValue(obj, key);
    if (value && keyCounts(key, value)) return true;
  }
  const children = propValue(obj, "children");
  if (children?.type !== "array" || depth > 8) return false;
  return children.namedChildren.some((c) => c.type === "object" && isRouteRecord(c, depth + 1));
}

/**
 * A literal path (`"/x"`, `'x'`, a template with no logic around it), or a
 * path constant this file declares (`ROUTES.HOME`, `` `${BASE}/users` ``);
 * null for any other expression (`'/' + r.path`).
 */
export function literalPath(value: Node): string | null {
  if (value.type === "string") return stripQuotes(value.text);
  if (value.type === "template_string") {
    const subs = value.namedChildren.filter((c) => c.type === "template_substitution");
    if (subs.length === 0) return stripQuotes(value.text);
    let out = value.text.slice(1, -1);
    for (const sub of subs) {
      const inner = sub.namedChildren[0];
      const resolved = inner ? constPath(inner) : null;
      if (resolved === null) return stripQuotes(value.text);
      out = out.replace(sub.text, resolved);
    }
    return out;
  }
  return constPath(value);
}

/**
 * A path named by a constant from another module (`paths.orders`, imported):
 * written as a `${…}` hole that the project pass (react-router-resolver.ts)
 * fills from the module's `moduleValues`, or drops when nothing does.
 */
export function pathHole(value: Node): string | null {
  if (value.type !== "identifier" && value.type !== "member_expression") return null;
  const name = value.text.replace(/\?\./g, ".");
  return /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(name) ? `\${${name}}` : null;
}

/**
 * A path a project helper builds from literal arguments
 * (`frontendURL('accounts/:accountId/inbox')`), written as a `${helper('…')}`
 * hole that the project pass (react-router-resolver.ts) fills from the
 * helper's `urlTemplate`, or drops when it cannot.
 */
export function helperHole(value: Node): string | null {
  if (value.type !== "call_expression") return null;
  const fn = value.childForFieldName("function");
  if (fn?.type !== "identifier") return null;
  const args: string[] = [];
  for (const a of value.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "comment") continue;
    if (a.type !== "string" && !(a.type === "template_string" && a.namedChildren.length === 0)) return null;
    const text = stripQuotes(a.text);
    if (/['"`(){}\\]/.test(text)) return null;
    args.push(`'${text}'`);
  }
  return args.length > 0 ? `\${${fn.text}(${args.join(", ")})}` : null;
}

/** A helper hole stands alone like an absolute path: the helper returns the whole path. */
function isHelperHole(path: string): boolean {
  return /^\$\{[A-Za-z_$][\w$]*\(/.test(path);
}

/** `const HOME = "/"`, `export const ROUTES = { admin: { users: "/admin/users" } } as const` — by dotted name. */
let constsTree: Tree | null = null;
let consts = new Map<string, string>();

function fileConsts(node: Node): Map<string, string> {
  if (node.tree === constsTree) return consts;
  constsTree = node.tree;
  consts = new Map();
  const collect = (name: string, value: Node | null, depth: number): void => {
    while (value && (value.type === "as_expression" || value.type === "satisfies_expression" || value.type === "parenthesized_expression")) value = value.namedChildren[0] ?? null;
    if (!value) return;
    if (value.type === "string" || (value.type === "template_string" && !value.namedChildren.some((c) => c.type === "template_substitution"))) {
      consts.set(name, stripQuotes(value.text));
    } else if (value.type === "object" && depth < 3) {
      for (const prop of value.namedChildren) {
        if (prop.type !== "pair") continue;
        const key = prop.childForFieldName("key");
        if (key && (key.type === "property_identifier" || key.type === "string")) collect(`${name}.${stripQuotes(key.text)}`, prop.childForFieldName("value"), depth + 1);
      }
    }
  };
  for (const stmt of node.tree.rootNode.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.namedChildren.find((c) => c.type === "lexical_declaration") : stmt;
    if (decl?.type !== "lexical_declaration" || !decl.text.startsWith("const")) continue;
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      if (name?.type === "identifier") collect(name.text, d.childForFieldName("value"), 0);
    }
  }
  return consts;
}

export function constPath(value: Node): string | null {
  if (value.type !== "identifier" && value.type !== "member_expression") return null;
  return fileConsts(value).get(value.text.replace(/\?\./g, ".")) ?? null;
}

/**
 * The path of the route record whose `children` hold `obj`, composed up the
 * chain, so a nested `{ path: "profile" }` under `{ path: "/user/:id" }`
 * reads `/user/:id/profile`. An absolute child path (`/x`) stands alone.
 */
function parentPath(obj: Node): string | null {
  const array = obj.parent;
  const pair = array?.type === "array" ? array.parent : null;
  if (!pair || (pair.type !== "pair" && pair.type !== "property_assignment") || pair.childForFieldName("key")?.text !== "children") return null;
  const parent = pair.parent;
  if (parent?.type !== "object") return null;
  const value = propValue(parent, "path");
  // A pathless layout route (`{ element: <Layout />, children: [...] }`) adds
  // no segment; one at the top level is the root ("").
  if (!value) return parentPath(parent) ?? (isNested(parent) ? null : "");
  const own = literalPath(value) ?? helperHole(value);
  if (own === null) return null;
  if (own.startsWith("/") || isHelperHole(own)) return own;
  const above = parentPath(parent);
  return above === null ? own : joinChild(above, own);
}

/** The path an object takes from a route it spreads (`{ ...rootRoute, children }`), when this file declares it. */
function spreadPath(obj: Node): string | null {
  for (const c of obj.namedChildren) {
    const id = c.type === "spread_element" ? c.namedChildren[0] : null;
    if (id?.type === "identifier") {
      const p = fileConsts(id).get(`${id.text}.path`);
      if (p !== undefined) return p;
    }
  }
  return null;
}

/** Whether a route object sits in some route's `children`. */
function isNested(obj: Node): boolean {
  const pair = obj.parent?.type === "array" ? obj.parent.parent : null;
  return !!pair && (pair.type === "pair" || pair.type === "property_assignment") && pair.childForFieldName("key")?.text === "children";
}

function joinChild(parent: string, child: string): string {
  if (child.startsWith("/") || isHelperHole(child)) return child;
  const head = parent.replace(/\/+$/, "");
  if (child === "") return parent;
  // Under a component-less root (`path: ""`) a child keeps its own spelling,
  // like a top-level Angular path (`"dashboard"`).
  if (head === "") return parent === "/" ? `/${child}` : child;
  return `${head}/${child}`;
}

/** Inspect a single node for a Vue Router route config object. */
export function visitVueRouterRoute(node: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  // TanStack's `createRoute({ path })` is relative to a parent; its own pass joins the chain.
  if (node.type === "object" && !isTanstackRouteOptions(node)) {
    let path: string | null = null;
    let handler: string | null = null;
    let componentPath: string | null = null;
    let isRouteConfig = false;
    let index = false;
    /** Where a redirect-only record sends the reader ("" when computed): Vue `redirect`, Angular `redirectTo`, `element: <Navigate>`. */
    let redirectTo: string | null = null;

    for (const prop of node.children) {
      if (prop.type === "pair" || prop.type === "property_assignment") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const keyText = key?.text;

        if (keyText === "path" && value) {
          path = literalPath(value) ?? helperHole(value) ?? pathHole(value);
        } else if ((keyText === "component" || keyText === "loadComponent" || keyText === "loadChildren") && value) {
          // Angular lazy routes carry the target in a `loadComponent`/
          // `loadChildren` thunk (`() => import('./x').then(m => m.XComponent)`)
          // instead of a bare `component` identifier — same join target.
          handler = componentHandler(value);
          componentPath = componentSpecifier(value);
        } else if ((keyText === "redirect" || keyText === "redirectTo") && value) {
          redirectTo = value.type === "string" ? stripQuotes(value.text) : "";
        } else if (keyText === "element" && value && isJsxValue(value) && redirectTargetOf(value) !== null) {
          redirectTo = redirectTargetOf(value);
        } else if (keyText === "element" && value && isJsxValue(value)) {
          // React Router data routers: `element: <Page />` — the page, as the JSX <Route> reads it.
          const c = componentOf(value);
          if (c) {
            handler = c.name;
            componentPath = c.specifier;
          }
        } else if (keyText === "Component" && value?.type === "identifier") {
          handler = value.text;
          componentPath = value.text;
        } else if (keyText === "lazy" && value && handler === null) {
          const lazy = value.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
          if (lazy) {
            handler = lazy[1]!.split("/").pop()!.replace(/\.\w+$/, "");
            componentPath = lazy[1]!;
          }
        } else if (keyText === "index" && value?.text === "true") {
          index = true;
        } else if (keyText === "name" && value && handler === null) {
          // Fall back to the route `name` for display only when no component
          // has set the handler yet — `component` is the stronger signal.
          handler = stripQuotes(value.text);
        }
      }
    }

    // An index route renders at its parent's path (the top-level one at "/").
    if (path === null && index && isRouteRecord(node)) {
      const above = parentPath(node);
      path = above === null ? (isNested(node) ? null : "/") : above || "/";
    }
    else if (path !== null && index) index = false;
    isRouteConfig = path !== null && isRouteRecord(node);
    if (path !== null && isRouteConfig) {
      const above = index ? null : parentPath(node);
      if (above !== null) path = joinChild(above, path);
      // A record that renders something AND redirects (a Vue parent with `component` and a
      // default-child `redirect`) is a page; only a bare redirect is wiring.
      const onlyRedirect = redirectTo !== null && componentPath === null;
      routes.push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler,
        componentPath,
        ...(onlyRedirect ? { redirectTo: redirectTo! } : {}),
        calls: [],
        middleware: [],
        line: node.startPosition.row + 1,
      });
    }
    // `children: appRoutes` / `children: [...appRoutes]`: an array declared
    // elsewhere (or above) whose routes sit under this one — composed by the
    // project pass (react-router-resolver.ts), which knows where it lives.
    const children = propValue(node, "children");
    if (facts && children && (path !== null || isNested(node) || propValue(node, "element") || spreadPath(node) !== null)) {
      // An array, its spreads, and route objects listed by name (`children: [ordersRoute, …]`).
      const names = children.type === "identifier"
        ? [children.text]
        : children.type === "array"
          ? children.namedChildren.flatMap((c) => (c.type === "spread_element" ? c.namedChildren[0] : c)).filter((c): c is Node => c?.type === "identifier").map((c) => c.text)
          : [];
      const parent = path ?? spreadPath(node) ?? parentPath(node) ?? "";
      for (const array of names) facts.push({ kind: "react-router-map", line: node.startPosition.row + 1, data: { array, head: "", pathProp: "path", componentProp: null, prefix: parent || null } });
    }
  }
}

/**
 * The `component` value of a route. A lazy-loaded component
 * (`() => import("./main.vue")`, or wrapped in `defineAsyncComponent`) carries
 * the target module rather than an identifier — surface the module's base name
 * (e.g. "main") so the route reads cleanly instead of showing the raw arrow.
 */
function componentHandler(value: Node): string {
  // Angular `() => import('./x').then((m) => m.XComponent)` — the class named
  // in the `.then` is the most precise handler (joins to the component symbol).
  // The arrow param may be bare (`m`), parenthesized (`(m)`), or destructured.
  const thenClass = value.text.match(/\.then\s*\(\s*\(?\s*(?:\w+|\{[^}]*\})\s*\)?\s*=>\s*[\w$]*\.?([A-Z][\w$]*)/);
  if (thenClass) return thenClass[1]!;
  const lazy = value.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
  if (lazy) {
    return lazy[1].split("/").pop()!.replace(/\.\w+$/, "");
  }
  return value.text;
}

/**
 * The module specifier the route's `component` resolves to, so the screen
 * builder can follow the route to the real page file:
 *   - lazy import (`() => import("./pak.vue")`) → "./pak.vue"
 *   - bare identifier (`component: Pak` for a statically-imported component)
 *     → "Pak" (resolved later against the file's imports)
 * Returns null for inline/anonymous components with no traceable target.
 */
function componentSpecifier(value: Node): string | null {
  const lazy = value.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
  if (lazy) return lazy[1];
  if (value.type === "identifier") return value.text;
  return null;
}
