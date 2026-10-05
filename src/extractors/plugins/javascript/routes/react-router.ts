import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { joinRoutePath } from "../../../shared/route-paths.js";

/** React Router: <Route path="/dashboard" component={X} /> */
export function extractReactRouterRoutes(root: Node, routes: RouteInfo[]): void {
  walkForJsxRoutes(root, routes);
}

function walkForJsxRoutes(node: Node, routes: RouteInfo[]) {
  visitReactRouterRoute(node, routes);
  for (const child of node.children) {
    walkForJsxRoutes(child, routes);
  }
}

/** Inspect a single node for a React Router `<Route …>` element. */
export function visitReactRouterRoute(node: Node, routes: RouteInfo[]): void {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode?.text === "Route") {
      let path = routeAttr(node, "path");
      const handlerRaw = routeAttrRaw(node, "component") ?? routeAttrRaw(node, "element");
      const rendered = renderedComponent(node);
      const handler = rendered?.name ?? (handlerRaw != null ? handlerRaw.replace(/[{}< />]/g, "").trim() : null);

      if (path) {
        // Nested <Route> composition: a child of <Route path="/seller"> with
        // path="product-list" matches /seller/product-list — the bare child
        // path never joins an api-call or screen on its own. A child written
        // ABSOLUTE (leading "/") already carries the full path in react-router
        // v6, so it passes through untouched.
        if (!path.startsWith("/")) {
          const prefix = ancestorRoutePrefix(node);
          if (prefix) path = joinRoutePath(prefix, path);
        }
        routes.push({
          path,
          httpMethod: null,
          kind: "frontend",
          handler,
          componentPath: rendered?.specifier ?? null,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

/** Attributes that name what a `<Route>` renders, strongest first (v5, v6.4 data router, v6, v5 render prop). */
const RENDER_ATTRIBUTES = ["component", "Component", "element", "render"];

/**
 * The page component a `<Route>` renders, as `componentPath` carries it: the
 * identifier of a statically-imported component (resolved later through the
 * file's imports) or the module of a lazy one. Without it the screen builder
 * could not follow a JSX route to its page — every page reached from
 * `<Route path="/@:username" component={Profile} />` was a screen with no
 * route, and the route file became a screen in its place.
 *
 * Read from the AST, not the attribute text:
 *  - `component={Profile}` / `Component={Profile}` → `Profile`
 *  - `element={<UserCard />}` → `UserCard`
 *  - a wrapper with one element child is unwrapped —
 *    `<RequireAuth><Dashboard /></RequireAuth>`, `<Suspense fallback={…}><Page /></Suspense>`
 *  - an HOC's last argument — `withRouter(Profile)`, `connect(map)(Profile)`
 *  - `lazy(() => import("./Profile"))` → `./Profile`
 *  - `render={() => <Profile />}`, and v5 children `<Route path="/x"><Profile /></Route>`
 *
 * Null when the route renders no single component: intrinsic markup
 * (`<h1>Welcome</h1>`), a conditional, several siblings. No guessing.
 */
function renderedComponent(openingEl: Node): { name: string; specifier: string } | null {
  for (const attrName of RENDER_ATTRIBUTES) {
    const value = routeAttrValue(openingEl, attrName);
    if (value) return componentOf(value);
  }
  // v5 children form: <Route path="/x"><Profile /></Route>
  const element = openingEl.type === "jsx_opening_element" ? openingEl.parent : null;
  return element?.type === "jsx_element" ? onlyChildComponent(element) : null;
}

function componentOf(node: Node): { name: string; specifier: string } | null {
  switch (node.type) {
    case "jsx_expression":
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? componentOf(inner) : null;
    }
    case "identifier":
      return { name: node.text, specifier: node.text };
    case "jsx_self_closing_element":
      return componentNamed(tagOf(node));
    case "jsx_element": {
      // A wrapper (guard, Suspense, layout) around exactly one element renders
      // that element; with no element children the element itself is the page.
      const children = elementChildren(node);
      if (children.length === 0) return componentNamed(tagOf(node));
      return children.length === 1 ? onlyChildComponent(node) : null;
    }
    case "arrow_function": {
      const body = node.childForFieldName("body");
      return body ? componentOf(body) : null;
    }
    case "call_expression": {
      const lazy = node.text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
      if (lazy) {
        const spec = lazy[1]!;
        return { name: spec.split("/").pop()!.replace(/\.\w+$/, ""), specifier: spec };
      }
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const last = args[args.length - 1];
      return last ? componentOf(last) : null;
    }
    default:
      return null;
  }
}

/** The element children of a `jsx_element` (text, expressions and its own open/close tags excluded). */
function elementChildren(element: Node): Node[] {
  return element.namedChildren.filter(
    (c) => c.type === "jsx_element" || c.type === "jsx_self_closing_element",
  );
}

/** The tag name of a JSX element, paired or self-closing. */
function tagOf(el: Node): string | undefined {
  const opener = el.type === "jsx_element" ? el.child(0) : el;
  return (opener?.childForFieldName("name") ?? opener?.child(1))?.text;
}

/** The component of a `jsx_element`'s single element child, or null for zero or several. */
function onlyChildComponent(element: Node): { name: string; specifier: string } | null {
  const children = elementChildren(element);
  if (children.length !== 1) return null;
  const tag = tagOf(children[0]!);
  if (tag === "Route" || tag === "Routes" || tag === "Switch") return null; // nested routing, not a page
  return componentOf(children[0]!);
}

/** A component reference by JSX tag: capitalized and unqualified. `<h1>` is markup; `<Foo.Bar>` has no import binding to follow. */
function componentNamed(tag: string | undefined): { name: string; specifier: string } | null {
  if (!tag || !/^[A-Z][\w$]*$/.test(tag)) return null;
  return { name: tag, specifier: tag };
}

/** The value node of a named attribute on a JSX opening element. */
function routeAttrValue(openingEl: Node, name: string): Node | null {
  for (const attr of openingEl.children) {
    if (attr.type !== "jsx_attribute") continue;
    const attrName = attr.childForFieldName("name")?.text ?? attr.child(0)?.text;
    if (attrName === name) return attr.child(2) ?? null;
  }
  return null;
}

/** The raw value text of a named attribute on a JSX opening element. */
function routeAttrRaw(openingEl: Node, name: string): string | null {
  return routeAttrValue(openingEl, name)?.text ?? null;
}

/** The string value of a named attribute on a JSX opening element, unquoted. */
function routeAttr(openingEl: Node, name: string): string | null {
  const raw = routeAttrRaw(openingEl, name);
  return raw != null ? stripQuotes(raw) : null;
}

/**
 * Accumulated path of every ancestor `<Route path=…>` wrapping this one,
 * outermost first (`/seller` for a route nested under <Route path="/seller">).
 * Climbs the JSX element chain — the fused route walk is stateless per node,
 * so parent context is recovered from the tree, not carried on a stack.
 */
function ancestorRoutePrefix(openingEl: Node): string | null {
  const segments: string[] = [];
  // A self-closing <Route .../> hangs DIRECTLY under the enclosing
  // jsx_element; a paired <Route>…</Route> has its own jsx_element wrapper
  // first. Walk from .parent and skip only the element this opener belongs to.
  let n: Node | null = openingEl.parent ?? null;
  while (n) {
    if (n.type === "jsx_element") {
      const opener = n.child(0);
      if (opener && opener.id !== openingEl.id && opener.type === "jsx_opening_element") {
        const tag = opener.childForFieldName("name") ?? opener.child(1);
        if (tag?.text === "Route") {
          const p = routeAttr(opener, "path");
          if (p) {
            segments.unshift(p);
            // An absolute ancestor is the composition root — stop climbing.
            if (p.startsWith("/")) break;
          }
        }
      }
    }
    n = n.parent;
  }
  return segments.length > 0 ? segments.reduce((acc, s) => joinRoutePath(acc, s)) : null;
}
