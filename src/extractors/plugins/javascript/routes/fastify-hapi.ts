import type { Node } from "web-tree-sitter";
import type { CallInfo, RouteInfo, RouteParamInfo, RouteResponseInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { applyRouteMeta, type GuardAttr } from "../../../shared/route-metadata.js";
import { collectCallNames } from "../../../routes/base.js";
import { responsesOf } from "../responses.js";
import { requiredSource } from "../imports-exports.js";
import {
  NON_ROUTER_RECEIVERS,
  guardFromMiddleware,
  handlerParamNames,
  inlineHandlerParams,
  isRoutePath,
  joinPrefix,
  receiverName,
  validatedBody,
} from "./express.js";

/**
 * Fastify and hapi: routes declared as objects, and plugins registered under a prefix.
 *
 * - `fastify.route({ method, url, handler })`, hapi `server.route({ method, path, handler })` and
 *   an array of them: one row per method (`'*'` is any method).
 * - `fastify.register(plugin, { prefix: "/api" })`, hapi `server.register(plugin, { routes: { prefix } })`
 *   and `server.register({ plugin, routes: { prefix } })`: an inline plugin function (or one this
 *   file declares) serves its routes under the prefix; an imported one becomes a mount the project
 *   mount pass resolves — by its binding, or by its module when it is loaded in place
 *   (`register(require("./clubs"), …)`).
 *
 * The shorthand `fastify.get("/x", …)` is the Express reader's.
 */

export function mayDeclareRouteObjects(sourceText: string): boolean {
  return /\.route\s*\(\s*[[{]/.test(sourceText);
}

export function mayRegisterPlugins(sourceText: string): boolean {
  return sourceText.includes(".register(") && sourceText.includes("prefix");
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function"]);

/** The pairs of an object literal by key (`url`, `'method'`). */
function pairsOf(obj: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (key && value) out.set(stripQuotes(key.text), value);
  }
  return out;
}

function stringValue(node: Node | undefined): string | null {
  return node && node.type === "string" ? stripQuotes(node.text) : null;
}

/** `'GET'`, `['PUT', 'PATCH']`, `'*'` → upper-case verbs, `ALL` for any. */
function methodsOf(node: Node | undefined): string[] {
  if (!node) return [];
  const raw = node.type === "array" ? node.namedChildren.map((n) => stringValue(n)) : [stringValue(node)];
  if (raw.some((m) => m === null)) return [];
  return [...new Set((raw as string[]).map((m) => (m === "*" ? "ALL" : m.toUpperCase())))];
}

/** hapi `auth: 'jwt'` / `auth: { strategy, scope }` / `auth: false`, as a guard. */
function hapiAuth(node: Node | undefined): GuardAttr | null {
  if (!node) return null;
  const text = `auth: ${node.text.replace(/\s+/g, " ")}`;
  if (node.type === "false") return { text, anonymous: true };
  const scheme = stringValue(node);
  if (scheme) return { text, schemes: [scheme] };
  if (node.type !== "object") return null;
  const pairs = pairsOf(node);
  const list = (n: Node | undefined): string[] => (n?.type === "array" ? n.namedChildren.map((c) => stringValue(c)).filter((s): s is string => !!s) : [stringValue(n)].filter((s): s is string => !!s));
  if (pairs.get("mode") && stringValue(pairs.get("mode")) !== "required") return null;
  return { text, schemes: [...list(pairs.get("strategy")), ...list(pairs.get("strategies"))], roles: list(pairs.get("scope")) };
}

/** One route object: `{ method, url | path, handler, preHandler, options: { handler, auth } }`. */
function routesOfObject(obj: Node): RouteInfo[] {
  const pairs = pairsOf(obj);
  const options = [pairs.get("options"), pairs.get("config")].find((n) => n?.type === "object");
  const opts = options ? pairsOf(options) : new Map<string, Node>();
  const path = stringValue(pairs.get("url")) ?? stringValue(pairs.get("path"));
  const methods = methodsOf(pairs.get("method"));
  if (!path || !isRoutePath(path) || methods.length === 0) return [];
  const handlerNode = pairs.get("handler") ?? opts.get("handler");
  if (!handlerNode) return [];
  const inline = FUNCTION_TYPES.has(handlerNode.type);
  const handler = !inline && (handlerNode.type === "identifier" || handlerNode.type === "member_expression") ? handlerNode.text : null;
  if (!inline && !handler) return [];

  // Fastify hooks that run before the handler (`preHandler: [fastify.authenticate]`), hapi `pre`.
  const middleware: string[] = [];
  const guards: GuardAttr[] = [];
  for (const key of ["onRequest", "preValidation", "preHandler"]) {
    const v = pairs.get(key) ?? opts.get(key);
    for (const m of v?.type === "array" ? v.namedChildren : v ? [v] : []) {
      if (m.type !== "identifier" && m.type !== "member_expression" && m.type !== "call_expression") continue;
      middleware.push(m.text.replace(/\s+/g, " "));
      const g = guardFromMiddleware(m);
      if (g) guards.push(g);
    }
  }
  const auth = hapiAuth(pairs.get("auth") ?? opts.get("auth"));
  if (auth) guards.push(auth);

  let calls: CallInfo[] = [];
  let params: RouteParamInfo[] = [];
  let responses: RouteResponseInfo[] | undefined;
  if (inline) {
    calls = collectCallNames(handlerNode);
    params = inlineHandlerParams(path, handlerNode, []);
    responses = responsesOf(handlerParamNames(handlerNode), handlerNode.childForFieldName("body"));
  }
  const body = validatedBody(obj) ?? (options ? validatedBody(options) : null);
  if (body) params = [{ name: "body", type: body, binding: "body", inferred: true }, ...params.filter((p) => p.binding !== "body")];

  return methods.map((method) => {
    const route: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler,
      calls,
      middleware: [...middleware],
      line: obj.startPosition.row + 1,
      ...(responses ? { responses } : {}),
    };
    return applyRouteMeta(route, { guards, params, filters: middleware.filter((m) => !guards.some((g) => g.text === m)) });
  });
}

/** `x.route({ … })` / `x.route([{ … }, …])` on a server, not on an HTTP client. */
export function visitRouteObjects(node: Node, routes: RouteInfo[]): void {
  if (node.type !== "call_expression") return;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "route") return;
  const receiver = receiverName(fn);
  if (receiver && (NON_ROUTER_RECEIVERS.has(receiver) || /client$/.test(receiver))) return;
  const arg = node.childForFieldName("arguments")?.namedChildren[0];
  const objects = arg?.type === "object" ? [arg] : arg?.type === "array" ? arg.namedChildren.filter((n) => n.type === "object") : [];
  for (const obj of objects) routes.push(...routesOfObject(obj));
}

/** A line range whose routes are served under `prefix`. */
interface PrefixScope {
  start: number;
  end: number;
  prefix: string;
}

/** The functions this file declares by name, with their line ranges. */
function declaredFunctions(root: Node): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  const range = (n: Node) => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") ?? stmt.namedChildren[0] : stmt;
    if (!decl) continue;
    if (decl.type === "function_declaration" || decl.type === "generator_function_declaration") {
      const name = decl.childForFieldName("name")?.text;
      if (name) out.set(name, range(decl));
    } else if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const d of decl.namedChildren) {
        const name = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (name?.type === "identifier" && value && FUNCTION_TYPES.has(value.type)) out.set(name.text, range(value));
      }
    }
  }
  return out;
}

/** What one `register(…)` call registers, with the prefix it gives: `[plugin node, prefix]` pairs. */
function registrations(call: Node): Array<[Node, string]> {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  const [first, opts] = args;
  if (!first) return [];
  const prefixOf = (o: Node | undefined): string | null => {
    if (o?.type !== "object") return null;
    const pairs = pairsOf(o);
    const routes = pairs.get("routes");
    return stringValue(pairs.get("prefix")) ?? (routes?.type === "object" ? stringValue(pairsOf(routes).get("prefix")) : null);
  };
  const outer = prefixOf(opts);
  // hapi: `register({ plugin, routes: { prefix } })`, or an array of them.
  const entries = first.type === "array" ? first.namedChildren : [first];
  const out: Array<[Node, string]> = [];
  for (const e of entries) {
    if (e.type === "object") {
      const plugin = pairsOf(e).get("plugin");
      const prefix = prefixOf(e) ?? outer;
      if (plugin && prefix) out.push([plugin, prefix]);
    } else if (outer) {
      out.push([e, outer]);
    }
  }
  return out;
}

/**
 * Plugins registered under a prefix. Inline and same-file plugin functions become prefix scopes
 * over their lines; an imported plugin becomes a mount row for the project mount pass.
 */
export function collectPluginPrefixes(root: Node, mounts: RouteInfo[]): PrefixScope[] {
  const scopes: PrefixScope[] = [];
  let local: Map<string, { start: number; end: number }> | null = null;
  const walk = (node: Node): void => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "register") {
        for (const [plugin, prefix] of registrations(node)) {
          if (!isRoutePath(prefix)) continue;
          const line = node.startPosition.row + 1;
          if (FUNCTION_TYPES.has(plugin.type)) {
            scopes.push({ start: plugin.startPosition.row + 1, end: plugin.endPosition.row + 1, prefix });
            continue;
          }
          const module = requiredSource(plugin);
          if (module !== null) {
            mounts.push({ path: prefix, httpMethod: null, kind: "api", handler: plugin.text, calls: [], middleware: [], line, mount: true, mountModule: module });
          } else if (plugin.type === "identifier") {
            local ??= declaredFunctions(root);
            const own = local.get(plugin.text);
            if (own) scopes.push({ ...own, prefix });
            else mounts.push({ path: prefix, httpMethod: null, kind: "api", handler: plugin.text, calls: [], middleware: [], line, mount: true });
          }
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return scopes;
}

/**
 * Serve each route inside a prefix scope under the scopes around it, outermost first. A plugin
 * function registered twice (two scopes over the same lines) serves its routes at both prefixes.
 */
export function applyPrefixScopes(scopes: readonly PrefixScope[], routes: RouteInfo[]): void {
  if (scopes.length === 0) return;
  const groups = new Map<string, PrefixScope[]>();
  for (const s of scopes) {
    const key = `${s.start}:${s.end}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const ordered = [...groups.values()].sort((a, b) => a[0]!.start - b[0]!.start || b[0]!.end - a[0]!.end);
  const next: RouteInfo[] = [];
  for (const r of routes) {
    let prefixes = [""];
    for (const group of ordered) {
      const s = group[0]!;
      if (r.line < s.start || r.line > s.end) continue;
      prefixes = prefixes.flatMap((p) => group.map((g) => joinPrefix(p, g.prefix)));
    }
    if (prefixes.length === 1 && prefixes[0] === "") next.push(r);
    else for (const p of prefixes) next.push({ ...r, path: joinPrefix(p, r.path) });
  }
  routes.splice(0, routes.length, ...next);
}
