import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { composedMiddleware, middlewareCalleeNames, NON_ROUTER_RECEIVERS } from "./express.js";

/** Koa bootstrap: named `app.use` middleware on a `new Koa()` app reaches every API route of the sub-project. */
export const KOA_APP_MIDDLEWARE = "koa-app-middleware";

export interface KoaAppMiddlewareFact {
  /** Named functions and factories (`preCheckMiddleware`, `koaBody`, `session`) — inline arrows name none. */
  calls: string[];
}

const KOA_IMPORT = /(?:from|import)\s+['"]koa['"]|require\s*\(\s*['"]koa['"]\s*\)/;
const KOA_APP = /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+Koa\s*\(/g;
/** The file wires the Koa instance into a server or mounts routers on it. */
const KOA_BOOT = /\.\s*callback\s*\(|mountRouters\s*\(|createServer\s*\(/;

function koaAppNames(sourceText: string): Set<string> {
  if (!KOA_IMPORT.test(sourceText) || !/\bnew\s+Koa\s*\(/.test(sourceText)) return new Set();
  return new Set([...sourceText.matchAll(KOA_APP)].map((m) => m[1]!.toLowerCase()));
}

function visitKoaUse(call: Node, apps: Set<string>, out: string[]): void {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "use") return;
  const recv = fn.childForFieldName("object");
  if (recv?.type !== "identifier" || !apps.has(recv.text.toLowerCase())) return;
  if (NON_ROUTER_RECEIVERS.has(recv.text.toLowerCase())) return;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length === 0) return;
  const pathFirst = args[0]!.type === "string" || args[0]!.type === "template_string";
  if (pathFirst) return;
  out.push(...middlewareCalleeNames(args.flatMap(composedMiddleware)));
}

/**
 * `app.use(preCheckMiddleware)` on a Koa bootstrap (`panel/src/app.ts`): only
 * named middleware and factories; anonymous `async (ctx, next) =>` handlers
 * name none. Requires `new Koa()` and a server/mount touch so an Express
 * namesake does not qualify.
 */
export function collectKoaAppMiddleware(root: Node, sourceText: string, facts: RouteFact[]): void {
  if (!KOA_IMPORT.test(sourceText) || !KOA_BOOT.test(sourceText)) return;
  const apps = koaAppNames(sourceText);
  if (apps.size === 0) return;
  const calls: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === "call_expression") visitKoaUse(node, apps, calls);
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "&&") {
      const right = node.childForFieldName("right");
      if (right?.type === "call_expression") visitKoaUse(right, apps, calls);
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  const unique = [...new Set(calls)];
  if (unique.length === 0) return;
  facts.push({ kind: KOA_APP_MIDDLEWARE, line: 1, data: { calls: unique } satisfies KoaAppMiddlewareFact });
}

/**
 * Every API route in a sub-project that bootstrapped Koa inherits the bootstrap
 * file's named app-level middleware as `inheritedMiddleware` (resolved there).
 */
export const koaAppMiddleware: RouteResolver = {
  id: "koa-app-middleware",
  languages: ["typescript", "javascript"],
  priority: 26,
  resolve(analyses: FileAnalysis[], _ctx: ProjectContext): void {
    const byProject = new Map<string, Array<{ file: string; calls: string[] }>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== KOA_APP_MIDDLEWARE) continue;
        const data = f.data as KoaAppMiddlewareFact;
        if (data.calls.length === 0) continue;
        const key = a.projectId ?? "";
        (byProject.get(key) ?? byProject.set(key, []).get(key)!).push({ file: a.filePath, calls: data.calls });
      }
    }
    if (byProject.size === 0) return;
    for (const a of analyses) {
      const globals = byProject.get(a.projectId ?? "");
      if (!globals?.length || !a.routes.some((r) => r.kind === "api" && !r.mount)) continue;
      a.routes = a.routes.map((r) => {
        if (r.kind !== "api" || r.mount) return r;
        let route = r;
        for (const g of globals) {
          const entry = { file: g.file, calls: g.calls };
          const existing = route.inheritedMiddleware ?? [];
          if (!existing.some((e) => e.file === entry.file && e.calls.join("\0") === entry.calls.join("\0"))) {
            route = { ...route, inheritedMiddleware: [...existing, entry] };
          }
        }
        return route;
      });
    }
  },
};