import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { collectCallNames } from "../../../routes/base.js";
import { stripQuotes } from "../../../shared/node-helpers.js";

/**
 * tRPC procedures as the HTTP routes they are served at. A router
 *
 *   export const postRouter = createTRPCRouter({
 *     byId: publicProcedure.input(z.string()).query(({ input }) => db.post.findUnique(…)),
 *     create: protectedProcedure.mutation(…),
 *   });
 *   export const appRouter = createTRPCRouter({ post: postRouter });
 *
 * (tRPC 11's router record — a plain `{ … } satisfies TRPCRouterRecord` of
 * procedures — is a router too)
 * serves `GET /trpc/post.byId` (a query) and `POST /trpc/post.create` (a
 * mutation) — the paths tRPC's HTTP link requests, under the conventional
 * `/trpc` mount. Each procedure is a row owned by the router variable, its
 * handler's calls on it; a router mounted under a key in another router is a
 * `trpc-mount` fact, and the project pass below prefixes the mounted router's
 * rows with the keys that lead to it from a root. A procedure built on
 * anything but the plain `publicProcedure`/`procedure` carries that builder
 * as middleware (`protectedProcedure`).
 */

export const TRPC_PREFIX = "/trpc/";
const ROUTER_CALLEE_RE = /^(?:[\w$]+\.)?(?:router|createTRPCRouter|createRouter)$/;
const PROCEDURE_VERBS: Record<string, string> = { query: "GET", mutation: "POST", subscription: "GET" };
const PLAIN_BUILDERS = new Set(["publicProcedure", "procedure", "baseProcedure"]);

/** The file may define tRPC routers: it names tRPC (`@trpc/server`, `./trpc`, `createTRPCRouter`) or builds procedures. */
export function mayDefineTrpc(sourceText: string): boolean {
  return /trpc/i.test(sourceText) || /\b\w*[Pp]rocedure\b/.test(sourceText);
}

const keyOf = (pair: Node): string | null => {
  const k = pair.childForFieldName("key");
  if (!k) return null;
  return k.type === "string" ? stripQuotes(k.text) : k.text;
};

/** `x.input(…).use(…).query(fn)` → the verb, the handler, the builder the chain starts on, and a named `.input(schema)`. */
function procedureOf(value: Node): { verb: string; handler: Node | null; builder: string; input: string | null } | null {
  if (value.type !== "call_expression") return null;
  const fn = value.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const verb = fn.childForFieldName("property")?.text ?? "";
  if (!(verb in PROCEDURE_VERBS)) return null;
  let root: Node | null = fn.childForFieldName("object");
  let input: string | null = null;
  while (root && (root.type === "call_expression" || root.type === "member_expression")) {
    if (root.type === "call_expression") {
      const f = root.childForFieldName("function");
      const arg = root.childForFieldName("arguments")?.namedChildren[0];
      if (f?.type === "member_expression" && f.childForFieldName("property")?.text === "input" && arg?.type === "identifier") input = arg.text;
    }
    root = root.type === "call_expression" ? root.childForFieldName("function") : root.childForFieldName("object");
  }
  const builder = root?.type === "identifier" ? root.text : "";
  const handler = value.childForFieldName("arguments")?.namedChildren[0] ?? null;
  return { verb, handler: handler && /function|arrow_function/.test(handler.type) ? handler : null, builder, input };
}

/** Collect the procedures and mounts of one router object, recursing into nested routers. */
function collectRouter(obj: Node, owner: string, prefix: string, routes: RouteInfo[], facts: RouteFact[] | undefined): void {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = keyOf(pair);
    const value = pair.childForFieldName("value");
    if (!key || !value) continue;
    const proc = procedureOf(value);
    if (proc) {
      routes.push({
        path: `${TRPC_PREFIX}${prefix}${key}`,
        httpMethod: PROCEDURE_VERBS[proc.verb]!,
        kind: "api",
        handler: null,
        calls: proc.handler ? collectCallNames(proc.handler) : [],
        middleware: proc.builder && !PLAIN_BUILDERS.has(proc.builder) ? [proc.builder] : [],
        line: pair.startPosition.row + 1,
        owner,
        // `.input(createPost)`: the request is the schema's type (a zod schema is a class, zod-schemas.ts).
        ...(proc.input ? { params: [{ name: "input", type: proc.input, binding: "body" as const, inferred: true }] } : {}),
      });
      continue;
    }
    const inner = routerObject(value);
    if (inner) {
      collectRouter(inner, owner, `${prefix}${key}.`, routes, facts);
    } else if (value.type === "object") {
      // tRPC 11: a plain object nests procedures under its key.
      collectRouter(value, owner, `${prefix}${key}.`, routes, facts);
    } else if (value.type === "identifier" || value.type === "member_expression") {
      facts?.push({ kind: "trpc-mount", line: pair.startPosition.row + 1, owner, data: { key: `${prefix}${key}`, router: value.text } });
    }
  }
}

/** The object literal a `router({ … })` call builds, or null. */
function routerObject(node: Node): Node | null {
  if (node.type !== "call_expression") return null;
  const callee = node.childForFieldName("function")?.text ?? "";
  if (!ROUTER_CALLEE_RE.test(callee)) return null;
  const arg = node.childForFieldName("arguments")?.namedChildren[0];
  return arg?.type === "object" ? arg : null;
}

/**
 * A tRPC 11 router record: a plain object (`{ … } satisfies TRPCRouterRecord`)
 * that holds at least one procedure.
 */
function routerRecord(node: Node): Node | null {
  let v: Node | null = node;
  while (v && (v.type === "satisfies_expression" || v.type === "as_expression" || v.type === "parenthesized_expression")) v = v.namedChildren[0] ?? null;
  if (v?.type !== "object") return null;
  return v.namedChildren.some((p) => p.type === "pair" && !!p.childForFieldName("value") && procedureOf(p.childForFieldName("value")!) !== null) ? v : null;
}

/** Per-node visitor: a `const x = router({ … })` declaration, or a router record. */
export function visitTrpcRouter(node: Node, routes: RouteInfo[], facts: RouteFact[] | undefined): void {
  if (node.type !== "variable_declarator") return;
  const value = node.childForFieldName("value");
  const obj = value ? routerObject(value) ?? routerRecord(value) : null;
  const owner = node.childForFieldName("name")?.text;
  if (!obj || !owner) return;
  facts?.push({ kind: "trpc-router", line: node.startPosition.row + 1, owner, data: {} });
  collectRouter(obj, owner, "", routes, facts);
}

interface MountData {
  key: string;
  router: string;
}

/**
 * tRPC sub-routers, served under the keys that mount them. A router mounted
 * nowhere is a root (its procedures keep their own keys); every other one's
 * rows are rewritten to the dotted path each root reaches them by — once per
 * path, so a router mounted twice serves twice. A mount whose router the
 * import graph cannot place joins nothing.
 */
export const trpcRouterResolver: RouteResolver = {
  id: "trpc-routers",
  languages: ["typescript", "javascript"],
  priority: 40,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const routers = new Set<string>();
    const children = new Map<string, Array<{ key: string; child: string }>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === "trpc-router" && f.owner) routers.add(`${a.filePath}#${f.owner}`);
      }
    }
    if (routers.size === 0) return;
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== "trpc-mount" || !f.owner) continue;
        const { key, router } = f.data as MountData;
        const name = router.split(".").pop()!;
        const file = router.includes(".") ? null : routers.has(`${a.filePath}#${name}`) ? a.filePath : ctx.importIndex.localFor(a.filePath, name);
        const child = file ? `${file}#${name}` : null;
        if (!child || !routers.has(child)) continue;
        const parent = `${a.filePath}#${f.owner}`;
        (children.get(parent) ?? children.set(parent, []).get(parent)!).push({ key, child });
      }
    }
    if (children.size === 0) return;
    const mounted = new Set([...children.values()].flat().map((c) => c.child));
    // Every dotted prefix a root reaches each mounted router by.
    const prefixes = new Map<string, string[]>();
    const walk = (router: string, prefix: string, seen: Set<string>): void => {
      for (const { key, child } of children.get(router) ?? []) {
        if (seen.has(child)) continue;
        const p = `${prefix}${key}.`;
        (prefixes.get(child) ?? prefixes.set(child, []).get(child)!).push(p);
        walk(child, p, new Set([...seen, child]));
      }
    };
    for (const r of routers) if (!mounted.has(r)) walk(r, "", new Set([r]));

    for (const a of analyses) {
      if (!a.routes.some((r) => r.owner && prefixes.has(`${a.filePath}#${r.owner}`) && r.path.startsWith(TRPC_PREFIX))) continue;
      const out: RouteInfo[] = [];
      for (const r of a.routes) {
        const ps = r.owner && r.path.startsWith(TRPC_PREFIX) ? prefixes.get(`${a.filePath}#${r.owner}`) : undefined;
        if (!ps) {
          out.push(r);
          continue;
        }
        const own = r.path.slice(TRPC_PREFIX.length);
        for (const p of ps) out.push({ ...r, path: `${TRPC_PREFIX}${p}${own}` });
      }
      a.routes = out;
    }
  },
};
