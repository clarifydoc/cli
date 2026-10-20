import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/**
 * React Navigation (React Native): the screens a navigator declares, as
 * frontend routes named by the screen's name — which is what
 * `navigation.navigate("Profile")` targets.
 *
 *   <Stack.Screen name="Profile" component={ProfileScreen} />          → route "Profile" → ProfileScreen
 *   <Tab.Screen name="Feed" component={Feed} options={{ … }} />
 *   createNativeStackNavigator({ screens: { Home: HomeScreen,           → route "Home" → HomeScreen
 *     Details: { screen: DetailsScreen } } })                           → route "Details" → DetailsScreen
 *
 * The component is the statically imported identifier the screen builder
 * follows to the page file. A screen rendered through a render function
 * (`{(props) => <Profile {...props} />}`) names the element it renders.
 * Only in a file that names React Navigation or builds a navigator.
 */

const NAVIGATOR_FACTORY = /\bcreate(?:NativeStack|Stack|BottomTab|MaterialTopTab|MaterialBottomTab|Drawer)Navigator\b/;

export function mayDeclareReactNavigation(sourceText: string): boolean {
  return sourceText.includes("@react-navigation") || NAVIGATOR_FACTORY.test(sourceText);
}

const attr = (el: Node, name: string): Node | null => {
  for (const a of el.namedChildren) {
    if (a.type === "jsx_attribute" && (a.childForFieldName("name") ?? a.namedChild(0))?.text === name) return a.namedChildren[a.namedChildren.length - 1] ?? null;
  }
  return null;
};

const literal = (n: Node | null): string | null => {
  if (!n) return null;
  if (n.type === "string") return stripQuotes(n.text);
  if (n.type === "jsx_expression") return literal(n.namedChild(0));
  if (n.type === "template_string" && !n.text.includes("${")) return stripQuotes(n.text);
  return null;
};

/** The component a `component={X}` / `getComponent={() => X}` / render child names. */
function componentOf(el: Node): string | null {
  const c = attr(el, "component");
  const inner = c?.type === "jsx_expression" ? c.namedChild(0) : c;
  if (inner && (inner.type === "identifier" || inner.type === "member_expression")) return inner.text;
  // `{(props) => <Profile {...props} />}` between opening and closing tags.
  const parent = el.parent;
  if (parent?.type === "jsx_element") {
    const fn = parent.namedChildren.find((ch) => ch.type === "jsx_expression")?.namedChild(0);
    const body = fn && /arrow_function|function/.test(fn.type) ? fn.childForFieldName("body") : null;
    const rendered = body?.type === "jsx_self_closing_element" || body?.type === "jsx_element" ? (body.type === "jsx_element" ? body.namedChild(0) : body) : null;
    const name = rendered?.childForFieldName("name")?.text;
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return null;
}

const screenRoute = (name: string, component: string | null, line: number): RouteInfo => ({
  path: name,
  httpMethod: null,
  kind: "frontend",
  handler: component,
  componentPath: component,
  calls: [],
  middleware: [],
  line,
});

/** Per-node visitor: `<X.Screen name="…" component={…} />`. */
export function visitReactNavigationScreen(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "jsx_self_closing_element" && node.type !== "jsx_opening_element") return;
  const tag = node.childForFieldName("name")?.text ?? "";
  if (!/^[\w$]+\.Screen$/.test(tag)) return;
  const name = literal(attr(node, "name"));
  if (!name) return;
  routes.push(screenRoute(name, componentOf(node), node.startPosition.row + 1));
}

/** The static configuration API: `createXNavigator({ screens: { Name: Comp, Other: { screen: Comp } } })`. */
export function visitStaticNavigator(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "call_expression" || !NAVIGATOR_FACTORY.test(node.childForFieldName("function")?.text ?? "")) return;
  const config = node.childForFieldName("arguments")?.namedChildren[0];
  if (config?.type !== "object") return;
  const screens = config.namedChildren.find((p) => p.type === "pair" && p.childForFieldName("key")?.text === "screens")?.childForFieldName("value");
  if (screens?.type !== "object") return;
  for (const pair of screens.namedChildren) {
    if (pair.type !== "pair" && pair.type !== "shorthand_property_identifier") continue;
    if (pair.type === "shorthand_property_identifier") {
      routes.push(screenRoute(pair.text, pair.text, pair.startPosition.row + 1));
      continue;
    }
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    const name = key ? (key.type === "string" ? stripQuotes(key.text) : key.text) : null;
    if (!name || !value) continue;
    let component: string | null = null;
    if (value.type === "identifier" || value.type === "member_expression") component = value.text;
    else if (value.type === "object") {
      const screen = value.namedChildren.find((p) => p.type === "pair" && p.childForFieldName("key")?.text === "screen")?.childForFieldName("value");
      if (screen && (screen.type === "identifier" || screen.type === "member_expression")) component = screen.text;
    }
    routes.push(screenRoute(name, component, pair.startPosition.row + 1));
  }
}
