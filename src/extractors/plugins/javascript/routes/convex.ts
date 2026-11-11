import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { collectCallNames } from "../../../routes/base.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/**
 * Convex functions as the routes they are called at. A module in the functions
 * directory
 *
 *   // convex/clubs.ts
 *   export const list = query({ args: {}, handler: async (ctx) => ctx.db.query("clubs").collect() });
 *   export const sign = mutation({ args: { clubId: v.id("clubs") }, handler: … });
 *
 * serves `GET /convex/clubs.list` (a query) and `POST /convex/clubs.sign` (a
 * mutation or an action): the module path and the export joined by dots, which
 * is how the client's generated reference names it (`api.clubs.list`; a
 * subfolder `api.admin.clubs.list` → `/convex/admin.clubs.list`). The colon of
 * Convex's own identifier (`clubs:list`) is a route parameter to every path
 * matcher, so the dot is used, as tRPC's procedures are. `internal*` functions
 * are rows too — `internal.x.y` reaches them — marked `internal`, because no
 * client of the deployment may call them. The functions directory is where the
 * module says it is: the `_generated/server` import's depth (`../_generated/server`
 * → one directory up), else a `convex/` segment, so a `convex.json`
 * `functions` setting needs no reading of its own.
 *
 * `convex/http.ts` is the other kind: `http.route({ path, method, handler })`
 * on an `httpRouter()` is an ordinary HTTP route at the path it states.
 *
 * Every reader is gated on the file naming Convex, so a namesake `query()`
 * elsewhere is untouched.
 */

export const CONVEX_PREFIX = "/convex/";

interface Builder {
  method: string;
  internal: boolean;
}

const BUILDERS: Record<string, Builder> = {
  query: { method: "GET", internal: false },
  mutation: { method: "POST", internal: false },
  action: { method: "POST", internal: false },
  internalQuery: { method: "GET", internal: true },
  internalMutation: { method: "POST", internal: true },
  internalAction: { method: "POST", internal: true },
};

/** The file names Convex: its server module, the generated API, a client package. */
export function namesConvex(sourceText: string): boolean {
  return /["'][^"']*_generated\/(?:server|api)(?:\.js)?["']|["']convex\/(?:server|react|browser|values|nextjs)["']|["']convex["']/.test(sourceText);
}

/** The file may declare Convex functions or an HTTP router. */
export function mayDefineConvex(sourceText: string): boolean {
  return /_generated\/server|["']convex\/server["']/.test(sourceText);
}

/**
 * `convex/admin/clubs.ts` → `admin.clubs`: the module path under the functions
 * directory, or null when the file is not in one (or is generated / the schema).
 */
export function convexModulePath(filePath: string, sourceText: string): string | null {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const file = parts.pop() ?? "";
  const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
  if (stem === file || parts.includes("_generated")) return null;
  let dirs: string[] | null = null;
  const imp = /["']((?:\.\.?\/)+)_generated\/server(?:\.js)?["']/.exec(sourceText);
  if (imp) {
    const up = imp[1]!.startsWith("./") ? 0 : imp[1]!.split("../").length - 1;
    if (up <= parts.length) dirs = parts.slice(parts.length - up);
  }
  if (!dirs) {
    const at = parts.lastIndexOf("convex");
    if (at >= 0) dirs = parts.slice(at + 1);
  }
  if (!dirs) return null;
  if (!dirs.length && (stem === "schema" || stem === "auth.config")) return null;
  return [...dirs, stem].join(".");
}

/** Builders this file defines through convex-helpers' `customQuery(query, …)` and friends. */
export function convexCustomBuilders(sourceText: string): Map<string, Builder> {
  const out = new Map<string, Builder>();
  for (const m of sourceText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*custom(Query|Mutation|Action)\s*\(\s*(internal)?/g)) {
    const base = BUILDERS[m[2]!.toLowerCase()]!;
    out.set(m[1]!, { ...base, internal: base.internal || !!m[3] });
  }
  return out;
}

/**
 * A builder this file EXPORTS and defines through convex-helpers' `customQuery(query, …)`:
 * a fact, so a module that imports it (`import { authedQuery } from "./lib/auth"`) serves its
 * functions. Gated on the file importing the helper from convex-helpers (or on the
 * `convex/server` family), so another library's `customQuery` defines nothing.
 */
export function convexExportedBuilders(sourceText: string): Array<{ name: string; method: string; internal: boolean }> {
  if (!/["']convex-helpers\/server\/customFunctions(?:\.js)?["']/.test(sourceText)) return [];
  const out: Array<{ name: string; method: string; internal: boolean }> = [];
  for (const m of sourceText.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*custom(Query|Mutation|Action)\s*\(\s*(internal)?/g)) {
    const base = BUILDERS[m[2]!.toLowerCase()]!;
    out.push({ name: m[1]!, method: base.method, internal: base.internal || !!m[3] });
  }
  return out;
}

/** Names this file imports from a relative module: `import { authedQuery as aq } from "./lib/auth"` → local `aq`, exported `authedQuery`. */
export function relativeImportNames(sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sourceText.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']\.{1,2}\//g)) {
    for (const part of m[1]!.split(",")) {
      const mm = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (mm) out.set(mm[2] ?? mm[1]!, mm[1]!);
    }
  }
  return out;
}

/** Top-level `const NAME = "text"` values of this file, for an `http.route` that names its path or method by one. */
export function stringConstants(sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sourceText.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w\s"'|]+)?=\s*(["'])([^"'\n]*)\2\s*(?:as\s+const)?\s*;?\s*$/gm)) out.set(m[1]!, m[3]!);
  return out;
}

const keyOf = (pair: Node): string | null => {
  const k = pair.childForFieldName("key");
  if (!k) return null;
  return k.type === "string" ? stripQuotes(k.text) : k.text;
};

/** The function a builder call is handed: the `handler` of its config object, or the function itself. */
function handlerOf(call: Node): { node: Node | null; ref: string | null } {
  const arg = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
  if (!arg) return { node: null, ref: null };
  if (/function|arrow_function/.test(arg.type)) return { node: arg, ref: null };
  if (arg.type !== "object") return { node: null, ref: null };
  for (const p of arg.namedChildren) {
    if (p.type === "method_definition" && p.childForFieldName("name")?.text === "handler") return { node: p, ref: null };
    if (p.type !== "pair" || keyOf(p) !== "handler") continue;
    const v = p.childForFieldName("value");
    if (!v) continue;
    if (/function|arrow_function/.test(v.type)) return { node: v, ref: null };
    if (v.type === "identifier" || v.type === "member_expression") return { node: null, ref: v.text.replace(/\s+/g, "") };
  }
  return { node: null, ref: null };
}

/** Per-node visitor: an exported `const list = query({ … })`. */
export function visitConvexFunction(node: Node, routes: RouteInfo[], modulePath: string, custom: Map<string, Builder>, imported?: Map<string, string>, facts?: RouteFact[]): void {
  if (node.type !== "variable_declarator") return;
  if (node.parent?.parent?.type !== "export_statement") return;
  const name = node.childForFieldName("name");
  const value = node.childForFieldName("value");
  if (name?.type !== "identifier" || value?.type !== "call_expression") return;
  const callee = value.childForFieldName("function");
  if (callee?.type !== "identifier") return;
  const builder = BUILDERS[callee.text] ?? custom.get(callee.text);
  const h = handlerOf(value);
  if (!builder) {
    // A builder another module of the project exports: the resolver places the route once it knows what that module defines.
    const from = imported?.get(callee.text);
    if (from && facts) {
      facts.push({
        kind: "convex-use",
        line: node.startPosition.row + 1,
        data: { local: callee.text, name: name.text, modulePath, handler: h.ref ?? name.text, calls: h.node ? collectCallNames(h.node) : [] },
      });
    }
    return;
  }
  routes.push({
    path: `${CONVEX_PREFIX}${modulePath}.${name.text}`,
    httpMethod: builder.method,
    kind: "api",
    handler: h.ref ?? name.text,
    calls: h.node ? collectCallNames(h.node) : [],
    middleware: BUILDERS[callee.text] ? [] : [callee.text],
    line: node.startPosition.row + 1,
    ...(builder.internal ? { internal: true as const } : {}),
  });
}

/** `http.route({ path: "/clubs", method: "POST", handler: httpAction(…) })` on an `httpRouter()`. */
export function visitConvexHttpRoute(node: Node, routes: RouteInfo[], consts?: Map<string, string>): void {
  if (node.type !== "call_expression") return;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "route") return;
  const arg = node.childForFieldName("arguments")?.namedChildren[0];
  if (arg?.type !== "object") return;
  let path: string | null = null;
  let prefix = false;
  let method = "GET";
  let handler: Node | null = null;
  for (const p of arg.namedChildren) {
    if (p.type !== "pair") continue;
    const k = keyOf(p);
    const v = p.childForFieldName("value");
    if (!v) continue;
    const text = v.type === "string" ? stripQuotes(v.text) : v.type === "identifier" ? (consts?.get(v.text) ?? null) : null;
    if ((k === "path" || k === "pathPrefix") && text !== null) {
      path = text;
      prefix = k === "pathPrefix";
    } else if (k === "method" && text !== null) method = text.toUpperCase();
    else if (k === "handler") handler = v;
  }
  if (path === null) return;
  const inner = handler?.type === "call_expression" ? handlerOf(handler) : { node: null, ref: null };
  routes.push({
    path: prefix ? `${path.replace(/\/$/, "")}/*` : path,
    httpMethod: method,
    kind: "api",
    handler: inner.ref ?? (handler?.type === "identifier" ? handler.text : null),
    calls: inner.node ? collectCallNames(inner.node) : [],
    middleware: [],
    line: node.startPosition.row + 1,
  });
}

interface UseData {
  local: string;
  name: string;
  modulePath: string;
  handler: string;
  calls: RouteInfo["calls"];
}

/**
 * Functions built with a custom builder another module defines
 * (`export const list = authedQuery({ … })`, `authedQuery` exported by
 * `convex/lib/auth.ts` from `customQuery(query, …)`): the import graph names the
 * defining file, whose exported builders say the verb. A callee the project
 * does not define as a Convex builder serves nothing.
 */
export const convexBuilderResolver: RouteResolver = {
  id: "convex-imported-builders",
  languages: ["typescript", "javascript"],
  priority: 38,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const defined = new Map<string, { method: string; internal: boolean }>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === "convex-builder") defined.set(`${a.filePath}#${(f.data as { name: string }).name}`, f.data as { method: string; internal: boolean });
      }
    }
    if (defined.size === 0) return;
    for (const a of analyses) {
      const uses = (a.routeFacts ?? []).filter((f) => f.kind === "convex-use");
      if (uses.length === 0) continue;
      const added: RouteInfo[] = [];
      for (const f of uses) {
        const u = f.data as UseData;
        const file = ctx.importIndex.localFor(a.filePath, u.local);
        const builder = file ? defined.get(`${file}#${u.local}`) : undefined;
        if (!builder) continue;
        added.push({
          path: `${CONVEX_PREFIX}${u.modulePath}.${u.name}`,
          httpMethod: builder.method,
          kind: "api",
          handler: u.handler,
          calls: u.calls,
          middleware: [u.local],
          line: f.line,
          ...(builder.internal ? { internal: true as const } : {}),
        });
      }
      if (added.length > 0) a.routes = [...a.routes, ...added];
    }
  },
};
