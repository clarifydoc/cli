import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { adoptExpressRoute, addExpressRouteGuards, joinPrefix, receiverName } from "./express.js";

/**
 * AdonisJS route chains the verb reader (`router.get('/clubs', [ClubsController, 'index'])`,
 * express.ts) cannot see alone:
 *
 * - `router.group(() => { … }).prefix('/admin').use(middleware.auth())` — the prefix and the
 *   guards belong to every route written inside the callback, groups nesting;
 * - `router.resource('clubs', ClubsController).apiOnly()` — the seven CRUD routes (`.apiOnly()`
 *   drops `create` and `edit`, `.only([…])` / `.except([…])` choose), `clubs.players` nesting
 *   under `/clubs/:club_id`;
 * - `router.get(…).use(middleware.auth())` — the route's own guard.
 */

export function mayDeclareAdonisRoutes(sourceText: string): boolean {
  return /adonis/i.test(sourceText) && /\.(?:group|resource|shallowResource)\s*\(|\)\s*\.\s*(?:use|middleware)\s*\(/.test(sourceText);
}

const VERBS = new Set(["get", "post", "put", "patch", "delete", "any", "route"]);
const ROOTS = new Set([...VERBS, "group", "resource", "shallowResource"]);

/** `resource` actions in Adonis's own order: method(s), path suffix. */
const RESOURCE_ACTIONS: Array<{ action: string; methods: string[]; suffix: string; api: boolean }> = [
  { action: "index", methods: ["GET"], suffix: "", api: true },
  { action: "create", methods: ["GET"], suffix: "/create", api: false },
  { action: "store", methods: ["POST"], suffix: "", api: true },
  { action: "show", methods: ["GET"], suffix: "/:id", api: true },
  { action: "edit", methods: ["GET"], suffix: "/:id/edit", api: false },
  { action: "update", methods: ["PUT", "PATCH"], suffix: "/:id", api: true },
  { action: "destroy", methods: ["DELETE"], suffix: "/:id", api: true },
];

interface Chain {
  root: Node;
  rootProp: string;
  mods: Array<{ prop: string; args: Node[] }>;
}

/** The chain a call ends: its root registration (`router.group(…)`) and the modifiers after it. */
function chainOf(node: Node): Chain | null {
  const mods: Chain["mods"] = [];
  let cur: Node | null = node;
  while (cur?.type === "call_expression") {
    const fn: Node | null = cur.childForFieldName("function");
    if (fn?.type !== "member_expression") return null;
    const prop = fn.childForFieldName("property")?.text ?? "";
    const object: Node | null = fn.childForFieldName("object");
    if (ROOTS.has(prop) && object?.type !== "call_expression") {
      // A registration on a router-like identifier, not a client's `.get(…)` of something.
      return receiverName(fn) ? { root: cur, rootProp: prop, mods } : null;
    }
    mods.unshift({ prop, args: cur.childForFieldName("arguments")?.namedChildren ?? [] });
    cur = object;
  }
  return null;
}

const lineOf = (n: Node) => n.startPosition.row + 1;

export function extractAdonisChains(root: Node, routes: RouteInfo[]): void {
  const chains: Chain[] = [];
  const walk = (node: Node): void => {
    // The outermost call of a chain only: a call that is the object of a further `.x(…)` is walked as part of it.
    const outer = node.type === "call_expression" && !(node.parent?.type === "member_expression" && node.parent.childForFieldName("object")?.id === node.id);
    const chain = outer ? chainOf(node) : null;
    if (chain && (chain.rootProp === "group" || chain.rootProp === "resource" || chain.rootProp === "shallowResource" || chain.mods.length > 0)) chains.push(chain);
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);

  const targets = new Map<Chain, RouteInfo[]>();
  // Resources first, so a group around one prefixes its rows; then the verbs' own chains.
  for (const chain of chains) {
    if (chain.rootProp === "resource" || chain.rootProp === "shallowResource") targets.set(chain, resourceRoutes(chain, routes));
    else if (VERBS.has(chain.rootProp)) targets.set(chain, routes.filter((r) => !r.mount && r.line === lineOf(chain.root)));
  }
  for (const chain of chains) {
    if (chain.rootProp === "group") {
      const fn = chain.root.childForFieldName("arguments")?.namedChildren.find((a) => /function|arrow_function/.test(a.type));
      if (fn) targets.set(chain, routes.filter((r) => !r.mount && r.line >= lineOf(fn) && r.line <= fn.endPosition.row + 1));
    }
  }
  // The smallest groups first: an inner prefix is joined before the outer one goes in front of it.
  const span = (c: Chain) => (c.rootProp === "group" ? c.root.endPosition.row - c.root.startPosition.row : 0);
  for (const chain of [...chains].sort((a, b) => span(a) - span(b))) {
    const rows = targets.get(chain) ?? [];
    for (const mod of chain.mods) {
      if (mod.prop === "prefix") {
        const arg = mod.args[0];
        if (arg?.type === "string") for (const r of rows) r.path = joinPrefix(stripQuotes(arg.text), r.path);
      } else if (mod.prop === "use" || mod.prop === "middleware") {
        for (const r of rows) addExpressRouteGuards(r, mod.args.flatMap((a) => (a.type === "array" ? a.namedChildren : [a])));
      }
    }
  }
}

function stringList(node: Node | undefined): string[] {
  return node?.type === "array" ? node.namedChildren.filter((n) => n.type === "string").map((n) => stripQuotes(n.text)) : [];
}

/** The routes `router.resource('clubs.players', PlayersController)` registers, appended to `routes`. */
function resourceRoutes(chain: Chain, routes: RouteInfo[]): RouteInfo[] {
  const [nameArg, controllerArg] = chain.root.childForFieldName("arguments")?.namedChildren ?? [];
  if (nameArg?.type !== "string" || !controllerArg || (controllerArg.type !== "identifier" && controllerArg.type !== "member_expression")) return [];
  const names = stripQuotes(nameArg.text).split(".").filter(Boolean);
  if (names.length === 0) return [];
  const base = names.map((n, i) => (i < names.length - 1 ? `/${n}/:${n.replace(/s$/, "")}_id` : `/${n}`)).join("");
  const controller = controllerArg.text.split(".").pop()!;
  const apiOnly = chain.mods.some((m) => m.prop === "apiOnly");
  const only = chain.mods.find((m) => m.prop === "only");
  const except = chain.mods.find((m) => m.prop === "except");
  const out: RouteInfo[] = [];
  for (const a of RESOURCE_ACTIONS) {
    if (apiOnly && !a.api) continue;
    if (only && !stringList(only.args[0]).includes(a.action)) continue;
    if (except && stringList(except.args[0]).includes(a.action)) continue;
    for (const method of a.methods) {
      const route: RouteInfo = { path: `${base}${a.suffix}`, httpMethod: method, kind: "api", handler: `${controller}.${a.action}`, calls: [], middleware: [], line: lineOf(chain.root) };
      adoptExpressRoute(route, receiverName(chain.root.childForFieldName("function")!));
      routes.push(route);
      out.push(route);
    }
  }
  return out;
}
