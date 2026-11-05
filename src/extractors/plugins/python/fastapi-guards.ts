import { posix } from "node:path";
import type { CallInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { withInheritedGuards, type GuardAttr } from "../../shared/route-metadata.js";

/** `class ClubRouter(APIRouter)` whose `__init__` hands `dependencies=[Depends(x)]` to the router it builds. */
export const PY_ROUTER_CLASS = "py:router-class";
export interface PyRouterClassFact {
  guards: GuardAttr[];
}

/** `router = ClubRouter(prefix=…)`: a router built by a project class, and the lines of the routes and mounts declared on it. */
export const PY_ROUTER_CTOR = "py:router-ctor";
export interface PyRouterCtorFact {
  variable: string;
  ctor: string;
  lines: number[];
}

/**
 * A class-based view (`@cbv(router)`, a project `@controller(router)`) or a
 * base of one: its class-level dependencies (`user: User = Depends(x)`),
 * which the framework resolves before every endpoint of the class and of each
 * subclass, and the lines of the routes declared in it.
 */
export const PY_VIEW_CLASS = "py:view-class";
export interface PyViewClassFact {
  /**
   * Every class-level attribute name with its guard; null for a non-guard, so a subclass can shadow a base's guard.
   * `dependency` is the callable its `Depends(…)` has the framework run (`get_current_user`).
   */
  attrs: Array<{ name: string; guard: GuardAttr | null; dependency?: string }>;
  lines: number[];
}

/**
 * FastAPI guards declared where one file cannot see them: on a project router
 * class (`router = MemberRouter()` with `MemberRouter.__init__` passing
 * `dependencies=[Depends(get_current_user)]`) and on a class-based view's base
 * (`class BaseMemberView: user = Depends(get_current_user)`). Per file the
 * extractor records the router classes, the routers they build and the view
 * classes with their routes; this pass follows the constructor and the base
 * chain through the class index and adds the guards to the routes — mounts
 * included, so a guarded router's `include_router` passes them on to the
 * routers it includes. A constructor or base the index cannot resolve adds
 * nothing. A view's class-level dependencies are run before each of its
 * endpoints, so each route also calls them (`return self.user` reaches what
 * `get_current_user` reads), named so they resolve from the route's own file.
 */
export const fastapiInheritedGuards: RouteResolver = {
  id: "fastapi-inherited-guards",
  languages: ["python"],
  priority: 25,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const routerClasses = new Map<ClassRef, GuardAttr[]>();
    const viewClasses = new Map<ClassRef, PyViewClassFact>();
    const users: Array<{ analysis: FileAnalysis; ctors: PyRouterCtorFact[]; views: Array<{ owner: string; fact: PyViewClassFact }> }> = [];
    const refIn = (file: string, name: string) => ctx.classes.classesIn(file).find((c) => c.cls.name === name) ?? null;
    for (const a of analyses) {
      const ctors: PyRouterCtorFact[] = [];
      const views: Array<{ owner: string; fact: PyViewClassFact }> = [];
      for (const f of a.routeFacts ?? []) {
        if (f.kind === PY_ROUTER_CLASS && f.owner) {
          const ref = refIn(a.filePath, f.owner);
          if (ref) routerClasses.set(ref, (f.data as PyRouterClassFact).guards);
        } else if (f.kind === PY_ROUTER_CTOR) {
          ctors.push(f.data as PyRouterCtorFact);
        } else if (f.kind === PY_VIEW_CLASS && f.owner) {
          const fact = f.data as PyViewClassFact;
          const ref = refIn(a.filePath, f.owner);
          if (ref) viewClasses.set(ref, fact);
          if (fact.lines.length > 0) views.push({ owner: f.owner, fact });
        }
      }
      if (ctors.length > 0 || views.length > 0) users.push({ analysis: a, ctors, views });
    }
    if (users.length === 0) return;

    const chainOf = (ref: ClassRef): ClassRef[] => [ref, ...ctx.classes.ancestors(ref).flatMap((s) => (s.ref ? [s.ref] : []))];

    for (const { analysis, ctors, views } of users) {
      const byLine = new Map<number, GuardAttr[]>();
      const add = (lines: readonly number[], guards: readonly GuardAttr[]) => {
        if (guards.length === 0) return;
        for (const line of lines) {
          const list = byLine.get(line) ?? byLine.set(line, []).get(line)!;
          for (const g of guards) if (!list.some((x) => x.text === g.text)) list.push(g);
        }
      };
      for (const c of ctors) {
        const ref = ctx.classes.resolve(analysis.filePath, c.ctor);
        if (!ref) continue;
        // The nearest class that builds the router with a dependencies list decides.
        const owner = chainOf(ref).find((r) => routerClasses.has(r));
        if (owner) add(c.lines, routerClasses.get(owner)!);
      }
      const depsByLine = new Map<number, string[]>();
      const calls = new Map<string, Omit<CallInfo, "line"> | null>();
      for (const v of views) {
        const ref = refIn(analysis.filePath, v.owner);
        if (!ref) continue;
        const seen = new Set<string>();
        const guards: GuardAttr[] = [];
        const deps: string[] = [];
        for (const cls of chainOf(ref)) {
          const fact = cls === ref ? v.fact : viewClasses.get(cls);
          for (const attr of fact?.attrs ?? []) {
            if (seen.has(attr.name)) continue; // shadowed by a subclass
            seen.add(attr.name);
            if (attr.guard) guards.push(attr.guard);
            if (!attr.dependency) continue;
            const key = `${cls.filePath}\0${attr.dependency}`;
            if (!calls.has(key)) calls.set(key, dependencyCall(attr.dependency, cls.filePath, analysis.filePath, ctx));
            if (calls.get(key) && !deps.includes(key)) deps.push(key);
          }
        }
        add(v.fact.lines, guards);
        for (const line of v.fact.lines) depsByLine.set(line, deps);
      }
      if (byLine.size === 0 && depsByLine.size === 0) continue;
      analysis.routes = analysis.routes.map((r) => {
        if (r.kind !== "api") return r;
        const guards = byLine.get(r.line);
        const route = guards ? withInheritedGuards(r, guards) : r;
        const deps = (depsByLine.get(r.line) ?? []).map((k) => ({ ...calls.get(k)!, line: r.line }) as CallInfo);
        const fresh = deps.filter((d) => !route.calls.some((c) => c.name === d.name));
        return fresh.length > 0 ? { ...route, calls: [...route.calls, ...fresh] } : route;
      });
    }
  },
};

/**
 * A class-level dependency as a call the route's own file resolves: the
 * function the declaring file defines or imports under that name, spelled by
 * the module the declaring file imports it from when that module is the same
 * file from the route's, else relative to the route's file. Null when the
 * dependency is no project function (`Depends(OAuth2PasswordBearer(…))`).
 */
function dependencyCall(dependency: string, declFile: string, routeFile: string, ctx: ProjectContext): Omit<CallInfo, "line"> | null {
  const decl = ctx.fileOf(declFile);
  if (!decl) return null;
  const [head, ...rest] = dependency.split(".");
  let name = dependency;
  let file: string | null = null;
  let written: string | null = null;
  if (decl.functions.some((f) => f.name === head) || decl.classes.some((c) => c.name === head)) file = declFile;
  else {
    const imp = decl.imports.find((i) => !i.isType && (i.specifiers.includes(head!) || i.aliases?.[head!] !== undefined));
    if (!imp) return null;
    const exported = imp.aliases?.[head!];
    if (exported && exported !== "default") name = [exported, ...rest].join(".");
    file = ctx.resolveModule(declFile, imp.source);
    written = imp.source;
  }
  if (!file) return null;
  // The view states the dependency: a call as certain as an import's.
  if (file === routeFile) return { name, kind: "internal", target: null, confidence: "EXTRACTED" };
  if (written && !written.startsWith(".") && ctx.resolveModule(routeFile, written) === file) return { name, kind: "cross-file", target: written, confidence: "EXTRACTED" };
  const relative = relativeModule(routeFile, file);
  return ctx.resolveModule(routeFile, relative) === file ? { name, kind: "cross-file", target: relative, confidence: "EXTRACTED" } : null;
}

/** `league/routes/players.py` → `league/core/deps.py`: `..core.deps`. */
function relativeModule(fromFile: string, toFile: string): string {
  const from = posix.dirname(fromFile).split("/").filter((x) => x && x !== ".");
  const to = toFile.replace(/\.pyi?$/, "").replace(/\/__init__$/, "").split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return ".".repeat(from.length - common + 1) + to.slice(common).join(".");
}
