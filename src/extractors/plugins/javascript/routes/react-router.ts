import type { Node } from "web-tree-sitter";
import type { RouteFact, RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { joinRoutePath } from "../../../shared/route-paths.js";
import { literalPath, pathHole } from "./vue-router.js";

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

/** A `<Route>` rendered per element of an array: `appRoutes.map((r) => <Route path={r.path} element={<r.view />} />)`. */
export interface RouteMapFact {
  array: string;
  /** Literal text written before the element's path: `'/' + r.path`, `` `/api/${r.path}` ``. */
  head: string;
  pathProp: string;
  /** The element property that names the page (`view` above), or null when none can be read. */
  componentProp: string | null;
  /** The enclosing `<Route>` paths, composed. */
  prefix: string | null;
}

/** A top-level array of route-shaped objects, for a `.map` elsewhere (or here) to render. */
export interface RouteArrayFact {
  name: string;
  items: Array<{ path: string; line: number; props: Record<string, { name: string; specifier: string }> }>;
  /** Arrays spread into this one (`[...partnerRoutes, …]`), by local name. */
  spreads?: string[];
}

/**
 * The path a `<Route>` declares: a string, a template, a constant this file
 * declares, or a `${name}` hole for one it imports (see `pathHole`). Null for
 * any other expression — `path={someCall()}` is not a path to report.
 */
function routePathOf(openingEl: Node): string | null {
  const value = routeAttrValue(openingEl, "path");
  if (!value) return null;
  if (value.type === "string") return stripQuotes(value.text);
  const inner = value.type === "jsx_expression" ? value.namedChildren[0] : null;
  if (!inner) return null;
  return literalPath(inner) ?? pathHole(inner);
}

/** The member read and any literal head: `r.path`, `'/' + r.path`, `` `/api/${r.path}` ``. */
function memberWithHead(expr: Node): { member: Node; head: string } | null {
  if (expr.type === "member_expression") return { member: expr, head: "" };
  if (expr.type === "binary_expression" && expr.childForFieldName("operator")?.text === "+") {
    const left = expr.childForFieldName("left");
    const right = expr.childForFieldName("right");
    if (left?.type === "string" && right?.type === "member_expression") return { member: right, head: stripQuotes(left.text) };
    return null;
  }
  if (expr.type === "template_string") {
    const subs = expr.namedChildren.filter((c) => c.type === "template_substitution");
    const inner = subs.length === 1 ? subs[0]!.namedChildren[0] : null;
    if (inner?.type !== "member_expression" || !expr.text.endsWith(`${subs[0]!.text}\``)) return null;
    return { member: inner, head: expr.text.slice(1, expr.text.length - 1 - subs[0]!.text.length) };
  }
  return null;
}

/** `r.path` inside `X.map((r) => <Route …/>)`: the array, the callback's parameter, the property read and its literal head. */
function mappedPath(openingEl: Node): { array: string; param: string; prop: string; head: string } | null {
  const inner = routeAttrValue(openingEl, "path");
  const raw = inner?.type === "jsx_expression" ? inner.namedChildren[0] : null;
  const read = raw ? memberWithHead(raw) : null;
  if (!read) return null;
  const expr = read.member;
  const obj = expr.childForFieldName("object");
  const prop = expr.childForFieldName("property")?.text;
  if (obj?.type !== "identifier" || !prop) return null;
  for (let n: Node | null = openingEl.parent; n; n = n.parent) {
    if (n.type !== "arrow_function" && n.type !== "function_expression") continue;
    const params = n.childForFieldName("parameters") ?? n.childForFieldName("parameter");
    const first = params?.type === "identifier" ? params : params?.namedChildren[0];
    const param = first?.type === "required_parameter" ? first.namedChildren[0] : first;
    if (param?.type !== "identifier" || param.text !== obj.text) return null;
    const call = n.parent?.type === "arguments" ? n.parent.parent : null;
    const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
    if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "map") return null;
    const array = fn.childForFieldName("object");
    return array?.type === "identifier" ? { array: array.text, param: param.text, prop, head: read.head } : null;
  }
  return null;
}

/** Which property of the mapped element names the page: `element={<r.view />}`, `Component={r.page}`, `element={r.element}`. */
function mappedComponentProp(openingEl: Node, param: string): string | null {
  for (const attr of RENDER_ATTRIBUTES) {
    const value = routeAttrValue(openingEl, attr);
    const inner = value?.type === "jsx_expression" ? value.namedChildren[0] : value;
    if (!inner) continue;
    const tag = inner.type === "jsx_self_closing_element" ? tagOf(inner) : inner.type === "jsx_element" ? tagOf(inner) : inner.type === "member_expression" ? inner.text : undefined;
    const m = tag ? new RegExp(`^${param.replace(/\$/g, "\\$")}\\.([\\w$]+)$`).exec(tag) : null;
    if (m) return m[1]!;
  }
  return null;
}

/** Inspect a single node for a React Router `<Route …>` element. */
export function visitReactRouterRoute(node: Node, routes: RouteInfo[], facts?: RouteFact[]): void {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode?.text === "Route") {
      const mapped = mappedPath(node);
      if (mapped) {
        const data: RouteMapFact = { array: mapped.array, head: mapped.head, pathProp: mapped.prop, componentProp: mappedComponentProp(node, mapped.param), prefix: ancestorRoutePrefix(node) };
        facts?.push({ kind: "react-router-map", line: node.startPosition.row + 1, data });
        return;
      }
      let path = routePathOf(node);
      // `<Route index element={<Home />} />` renders at its parent's path.
      if (path === null && hasAttr(node, "index")) path = ancestorRoutePrefix(node) ?? "/";
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
        const redirect = RENDER_ATTRIBUTES.map((a) => routeAttrValue(node, a)).map((v) => (v ? redirectTargetOf(v) : null)).find((r) => r !== null) ?? null;
        routes.push({
          path,
          httpMethod: null,
          kind: "frontend",
          handler,
          // A redirect renders no page of its own: there is no component to follow.
          componentPath: redirect !== null ? null : (rendered?.specifier ?? null),
          ...(redirect !== null ? { redirectTo: redirect } : {}),
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

export function componentOf(node: Node): { name: string; specifier: string } | null {
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

/** Whether a JSX opening element carries an attribute (`index`, `index={true}`). */
function hasAttr(openingEl: Node, name: string): boolean {
  for (const attr of openingEl.children) {
    if (attr.type !== "jsx_attribute") continue;
    if ((attr.childForFieldName("name")?.text ?? attr.child(0)?.text) === name) {
      const v = attr.child(2);
      return !v || v.text !== "{false}";
    }
  }
  return false;
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

/** React Router's redirect elements: v6+ `<Navigate to>`, v5 `<Redirect to>`. */
const REDIRECT_TAGS = new Set(["Navigate", "Redirect"]);

/**
 * Where a route's rendered value sends the reader when it only redirects —
 * `element={<Navigate to="/home" replace />}` — or null when it renders
 * something. "" when the target is computed rather than written.
 */
export function redirectTargetOf(value: Node): string | null {
  let v: Node | null = value;
  // `{…}`, `(…)` and `render={() => <Redirect …/>}` wrap the element.
  while (v && (v.type === "jsx_expression" || v.type === "parenthesized_expression" || v.type === "arrow_function")) {
    v = v.type === "arrow_function" ? v.childForFieldName("body") : (v.namedChildren[0] ?? null);
  }
  if (!v) return null;
  const opener = v.type === "jsx_element" ? v.child(0) : v.type === "jsx_self_closing_element" ? v : null;
  const tag = opener ? (opener.childForFieldName("name") ?? opener.child(1))?.text : undefined;
  if (!opener || !tag || !REDIRECT_TAGS.has(tag)) return null;
  const to = routeAttrValue(opener, "to");
  return to?.type === "string" ? to.text.slice(1, -1) : "";
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
          const p = routePathOf(opener);
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

/**
 * Top-level arrays of route-shaped objects (`export const appRoutes = [{
 * path: "/menu", view: MenuPage }]`): what a `.map` into `<Route>` renders,
 * or a route's `children: appRoutes` holds — possibly from another file. Each
 * item keeps its line and the components its properties name; which property
 * is the page, only the `.map` site says. Only arrays another file can reach
 * (exported) or this file maps into a `<Route>` are kept.
 */
export function collectRouteArrays(root: Node, sourceText: string, facts: RouteFact[]): void {
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.namedChildren.find((c) => c.type === "lexical_declaration") : stmt;
    if (decl?.type !== "lexical_declaration") continue;
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      let value = d.childForFieldName("value");
      while (value && (value.type === "as_expression" || value.type === "satisfies_expression" || value.type === "parenthesized_expression")) value = value.namedChildren[0] ?? null;
      if (name?.type !== "identifier" || (value?.type !== "array" && value?.type !== "object")) continue;
      // A route object of its own (`export const ordersRoute = { path, element }`) is an array of one.
      if (value.type === "object" && !/\bpath\s*:/.test(value.text.slice(0, 2000))) continue;
      if (value.type === "object" ? stmt.type !== "export_statement" && sourceText.split(name.text).length < 3 : stmt.type !== "export_statement" && !(sourceText.includes("<Route") && new RegExp(`\\b${name.text.replace(/\$/g, "\\$")}\\s*\\.\\s*map\\s*\\(`).test(sourceText))) continue;
      const items: RouteArrayFact["items"] = [];
      const spreads: string[] = [];
      for (const el of value.type === "object" ? [value] : value.namedChildren) {
        if (el.type === "spread_element" && el.namedChildren[0]?.type === "identifier") spreads.push(el.namedChildren[0].text);
        if (el.type !== "object") continue;
        let path: string | null = null;
        const props: RouteArrayFact["items"][number]["props"] = {};
        for (const pair of el.namedChildren) {
          if (pair.type !== "pair") continue;
          const key = pair.childForFieldName("key")?.text;
          const v = pair.childForFieldName("value");
          if (!key || !v) continue;
          if (key === "path") path = literalPath(v) ?? pathHole(v);
          else if (v.type === "identifier" && /^[A-Z]/.test(v.text)) props[key] = { name: v.text, specifier: v.text };
          else {
            const c = v.type === "jsx_element" || v.type === "jsx_self_closing_element" || v.type === "arrow_function" || v.type === "call_expression" ? componentOf(v) : null;
            if (c) props[key] = c;
          }
        }
        if (path !== null) items.push({ path, line: el.startPosition.row + 1, props });
      }
      if (items.length > 0 || spreads.length > 0) {
        facts.push({ kind: "react-router-array", line: d.startPosition.row + 1, data: { name: name.text, items, ...(spreads.length ? { spreads } : {}) } satisfies RouteArrayFact });
      }
    }
  }
}
