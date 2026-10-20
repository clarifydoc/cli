import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { findChildByType } from "../../../shared/node-helpers.js";

/**
 * Jetpack Compose navigation (Android): the destinations a `NavHost` graph
 * declares, as frontend routes.
 *
 *   NavHost(navController, startDestination = "home") {
 *     composable("home") { HomeScreen(navController) }                  → route "home" → HomeScreen
 *     composable("profile/{userId}") { entry -> ProfileScreen(…) }      → route "profile/{userId}" → ProfileScreen
 *     composable<Settings> { SettingsScreen() }                         → route "Settings" (type-safe)
 *     dialog("confirm") { ConfirmDialog() }
 *     navigation(startDestination = "a", route = "wizard") { composable("a") { … } }
 *   }
 *
 * The page is the first composable the destination's lambda calls (a
 * PascalCase function), which the screen builder follows to its file. Grammar
 * shape as Ktor's DSL: `composable("x") { … }` is a call wrapped by the call
 * carrying the trailing lambda. Only in a file that names a NavHost.
 */

const DESTINATIONS = new Set(["composable", "dialog", "bottomSheet"]);

const calleeName = (call: Node): string | null => {
  const c = call.child(0);
  return c?.type === "simple_identifier" ? c.text : null;
};

function firstStringArg(call: Node): string | null {
  const args = findChildByType(findChildByType(call, "call_suffix") ?? call, "value_arguments");
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== "value_argument") continue;
    // `route = "x"` named or the first positional.
    const label = arg.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    const s = findChildByType(arg, "string_literal");
    if (s && (!label || label === "route")) return s.text.replace(/^"|"$/g, "");
  }
  return null;
}

/** `composable<Settings>` — a type-safe destination names its route class. */
function typeArgument(call: Node): string | null {
  const suffix = findChildByType(call, "call_suffix");
  const typeArgs = suffix ? findChildByType(suffix, "type_arguments") : null;
  return typeArgs?.namedChildren[0]?.text.replace(/^.*\./, "") ?? null;
}

/** The first PascalCase function the lambda calls: the destination's page. */
function pageOf(lambda: Node | null): string | null {
  if (!lambda) return null;
  let found: string | null = null;
  const walk = (n: Node): void => {
    if (found) return;
    if (n.type === "call_expression") {
      const name = calleeName(n);
      if (name && /^[A-Z]/.test(name)) {
        found = name;
        return;
      }
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(lambda);
  return found;
}

export function extractComposeDestinations(root: Node, routes: RouteInfo[]): void {
  const visit = (node: Node): void => {
    if (node.type === "call_expression") {
      const inner = node.child(0);
      // `composable("x") { … }`: the outer call carries the lambda, the inner one the route.
      const head = inner?.type === "call_expression" ? inner : node;
      const name = calleeName(head);
      if (name && DESTINATIONS.has(name)) {
        const route = firstStringArg(head) ?? typeArgument(head);
        const lambda = findChildByType(findChildByType(node, "call_suffix") ?? node, "annotated_lambda");
        if (route && lambda) {
          const page = pageOf(lambda);
          routes.push({ path: route, httpMethod: null, kind: "frontend", handler: page, componentPath: page, calls: [], middleware: [], line: node.startPosition.row + 1 });
          return;
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  };
  visit(root);
}
