import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

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
 * Covers Vue Router (`component`/`redirect`/`beforeEnter`) AND Angular Router
 * (`loadComponent`/`loadChildren`/`redirectTo`/`canActivate`) — both are
 * `{ path, component }[]` config arrays, so one object visitor handles both
 * with no risk of double-emitting the shared `{ path, component }` shape.
 */
const ROUTE_CONFIG_KEYS = new Set([
  "component", "components", "redirect", "beforeEnter",
  "loadComponent", "loadChildren", "redirectTo", "canActivate",
]);

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
function isRouteRecord(obj: Node, depth = 0): boolean {
  for (const key of ROUTE_CONFIG_KEYS) {
    const value = propValue(obj, key);
    if (!value) continue;
    if ((key === "component" || key === "components") && NON_COMPONENT_VALUES.has(value.type)) continue;
    return true;
  }
  const children = propValue(obj, "children");
  if (children?.type !== "array" || depth > 8) return false;
  return children.namedChildren.some((c) => c.type === "object" && isRouteRecord(c, depth + 1));
}

/** A literal path (`"/x"`, `'x'`, a template with no logic around it); null for an expression (`'/' + r.path`). */
function literalPath(value: Node): string | null {
  if (value.type === "string") return stripQuotes(value.text);
  if (value.type === "template_string") return stripQuotes(value.text);
  return null;
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
  const own = value ? literalPath(value) : null;
  if (own === null) return null;
  if (own.startsWith("/")) return own;
  const above = parentPath(parent);
  return above === null ? own : joinChild(above, own);
}

function joinChild(parent: string, child: string): string {
  if (child.startsWith("/")) return child;
  const head = parent.replace(/\/+$/, "");
  if (child === "") return parent;
  // Under a component-less root (`path: ""`) a child keeps its own spelling,
  // like a top-level Angular path (`"dashboard"`).
  if (head === "") return parent === "/" ? `/${child}` : child;
  return `${head}/${child}`;
}

/** Inspect a single node for a Vue Router route config object. */
export function visitVueRouterRoute(node: Node, routes: RouteInfo[]): void {
  if (node.type === "object") {
    let path: string | null = null;
    let handler: string | null = null;
    let componentPath: string | null = null;
    let isRouteConfig = false;

    for (const prop of node.children) {
      if (prop.type === "pair" || prop.type === "property_assignment") {
        const key = prop.childForFieldName("key");
        const value = prop.childForFieldName("value");
        const keyText = key?.text;

        if (keyText === "path" && value) {
          path = literalPath(value);
        } else if ((keyText === "component" || keyText === "loadComponent" || keyText === "loadChildren") && value) {
          // Angular lazy routes carry the target in a `loadComponent`/
          // `loadChildren` thunk (`() => import('./x').then(m => m.XComponent)`)
          // instead of a bare `component` identifier — same join target.
          handler = componentHandler(value);
          componentPath = componentSpecifier(value);
        } else if (keyText === "name" && value && handler === null) {
          // Fall back to the route `name` for display only when no component
          // has set the handler yet — `component` is the stronger signal.
          handler = stripQuotes(value.text);
        }
      }
    }

    isRouteConfig = path !== null && isRouteRecord(node);
    if (path !== null && isRouteConfig) {
      const above = parentPath(node);
      if (above !== null) path = joinChild(above, path);
      routes.push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler,
        componentPath,
        calls: [],
        middleware: [],
        line: node.startPosition.row + 1,
      });
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
