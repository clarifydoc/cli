import type { FileAnalysis } from "../../../types/analysis.js";
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
  /** Every class-level attribute name with its guard; null for a non-guard, so a subclass can shadow a base's guard. */
  attrs: Array<{ name: string; guard: GuardAttr | null }>;
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
 * nothing.
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
      for (const v of views) {
        const ref = refIn(analysis.filePath, v.owner);
        if (!ref) continue;
        const seen = new Set<string>();
        const guards: GuardAttr[] = [];
        for (const cls of chainOf(ref)) {
          const fact = cls === ref ? v.fact : viewClasses.get(cls);
          for (const attr of fact?.attrs ?? []) {
            if (seen.has(attr.name)) continue; // shadowed by a subclass
            seen.add(attr.name);
            if (attr.guard) guards.push(attr.guard);
          }
        }
        add(v.fact.lines, guards);
      }
      if (byLine.size === 0) continue;
      analysis.routes = analysis.routes.map((r) => {
        const guards = r.kind === "api" ? byLine.get(r.line) : undefined;
        return guards ? withInheritedGuards(r, guards) : r;
      });
    }
  },
};
