import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { HTTP_METHODS } from "../../../routes/base.js";
import type { GuardAttr } from "../../../shared/route-metadata.js";
import { ROUTER_CALL, resolveRouterFunctions, type RouterCall } from "../../shared/router-functions.js";
import { NOT_HELPERS, ROUTER_ARG, ROUTER_ARG_PASSED, appFactoryNames, enclosingFunction } from "./path-helpers.js";

/**
 * Express routes registered by a function on the router it is handed:
 *
 *     function mountClubs(router) { router.get("/list", handler); }
 *     const r = express.Router();
 *     mountClubs(r);
 *     app.use("/clubs", r);          // GET /clubs/list; the mount itself serves nothing
 *
 * The reader (`express.ts`) marks each route registered on a parameter of a named function `owner: "fn:<name>"`
 * and `collectRouterCalls` states each call handing that function a router as a `router-call` fact: the router's
 * prefix there (the literal of its `use` mount in the same file, or none for the application itself), its mount's
 * guards, or "relative" for a router the caller was itself handed. The Go and Ktor readers use the same facts, so
 * `plugins/shared/router-functions.ts` composes them. A function no call reaches keeps its bare paths; a router
 * mounted in another file (exported, not mounted here) states no fact and the call joins nothing. The kit drops
 * the `owner` marker when it is done.
 */

/** The router-call fact's data here: the shared shape plus the mount row it came through (dropped once served). */
export interface ExpressRouterCall extends RouterCall {
  /** The router variable handed on and the line of its `use` mount, when it is mounted in this file. */
  mounted?: { router: string; line: number };
}

/** Every call in the file handing a router on to a function: `mountClubs(r)` with `r` mounted here, `mountClubs(app)`, `mountAll(router)`. */
export function collectRouterCalls(
  root: Node,
  routes: readonly RouteInfo[],
  sourceText: string,
  facts: RouteFact[],
  guardsOf: (route: RouteInfo) => GuardAttr[],
): void {
  const mounts = new Map<string, Array<{ prefix: string; line: number; guards: GuardAttr[] }>>();
  for (const r of routes) {
    if (!r.mount || !r.handler || r.mountModule || !/^[A-Za-z_$][\w$]*$/.test(r.handler)) continue;
    (mounts.get(r.handler) ?? mounts.set(r.handler, []).get(r.handler)!).push({ prefix: r.path, line: r.line, guards: guardsOf(r) });
  }
  // A router handed on is a mounted variable, or a conventional router name (relayed by a function that was handed it).
  if (mounts.size === 0 && !ROUTER_ARG_PASSED.test(sourceText)) return;
  const apps = appFactoryNames(sourceText);
  const own: RouteFact[] = [];
  const atRoot: RouteFact[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "identifier" && !(fn?.type === "member_expression" && fn.childForFieldName("object")?.type === "identifier")) continue;
    const leaf = fn.type === "identifier" ? fn.text : fn.childForFieldName("property")?.text;
    if (!leaf || NOT_HELPERS.has(leaf) || HTTP_METHODS.has(leaf.toLowerCase())) continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const handed = args.some((a) => a.type === "identifier" && (mounts.has(a.text) || apps.has(a.text) || ROUTER_ARG.test(a.text)));
    if (!handed) continue;
    const enclosing = enclosingFunction(call);
    const line = call.startPosition.row + 1;
    for (const a of args) {
      if (a.type !== "identifier") continue;
      const base = { callee: fn.text, relative: false, guards: [] as GuardAttr[] };
      const push = (data: ExpressRouterCall, owner?: string, into = own) => into.push({ kind: ROUTER_CALL, line, ...(owner ? { owner } : {}), data });
      if (enclosing?.params.includes(a.text)) {
        if (ROUTER_ARG.test(a.text)) push({ ...base, prefix: "", relative: true }, enclosing.name);
      } else if (mounts.has(a.text)) {
        for (const m of mounts.get(a.text)!) push({ ...base, prefix: m.prefix, guards: m.guards, mounted: { router: a.text, line: m.line } });
      } else if (apps.has(a.text)) {
        push({ ...base, prefix: "" }, undefined, atRoot);
      }
    }
  }
  // The application handed on says something only beside a router handed to the same function (`mountClubs(app)`
  // and `mountClubs(r)`): alone it serves the paths as written.
  const beside = new Set(own.map((f) => (f.data as RouterCall).callee));
  facts.push(...own, ...atRoot.filter((f) => beside.has((f.data as RouterCall).callee)));
}

/** The one function a callee names: in the caller's own file, or in the file its import (or a namespace) binds. */
function targetOf(ctx: ProjectContext) {
  return (callee: string, caller: FileAnalysis, keysNamed: (fn: string) => string[]): string | null => {
    const dot = callee.indexOf(".");
    const name = dot < 0 ? callee : callee.slice(dot + 1);
    const own = `${caller.filePath}#${name}`;
    const keys = keysNamed(name);
    let file: string | null;
    if (dot < 0) {
      if (keys.includes(own)) return own;
      file = ctx.importIndex.localFor(caller.filePath, name);
    } else {
      file = ctx.importIndex.localFor(caller.filePath, callee.slice(0, dot));
    }
    const key = file ? `${file}#${name}` : null;
    return key && keys.includes(key) ? key : null;
  };
}

/** Serves each function's routes at the prefixes its calls reach it by, and drops the mounts that only carried the router there. */
export const expressRouterFunctionResolver: RouteResolver = {
  id: "express-router-functions",
  languages: ["typescript", "javascript"],
  priority: 45,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    resolveRouterFunctions(analyses, {
      unitOf: (p) => p,
      target: targetOf(ctx),
      // A function every call hands the application itself serves its paths as written.
      skipPlain: true,
      // A mount that only carried a router to a function serves nothing of its own.
      served(f, a) {
        const m = (f.data as ExpressRouterCall).mounted;
        if (m) a.routes = a.routes.filter((r) => !(r.mount && r.handler === m.router && r.line === m.line));
      },
    });
  },
};
