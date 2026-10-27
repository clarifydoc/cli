import type { Node } from "web-tree-sitter";
import type { FileAnalysis, Language, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { withInheritedGuards, type GuardAttr } from "../../shared/route-metadata.js";

/**
 * Class-level guards a controller inherits from a base class in another file —
 * Spring's `@PreAuthorize` on an abstract `SecuredController`, NestJS's
 * `@UseGuards(AuthGuard('jwt'))` on a `BaseController`. Both frameworks look a
 * class-level guard up the superclass chain, and the nearest class that
 * declares one decides. Per file a plugin records each class's own guards
 * (`class-guards`) and, for a class with routes but no guard of its own, the
 * lines of those routes (`class-routes`); the resolver follows the `extends`
 * chain through the class index and gives the routes the nearest ancestor's
 * guards. A base the index cannot resolve adds nothing.
 */
export const CLASS_GUARDS = "class-guards";
export const CLASS_ROUTES = "class-routes";
interface ClassGuardsFact {
  guards: GuardAttr[];
}
interface ClassRoutesFact {
  lines: number[];
}

/**
 * The facts for one file: `classes` are its class declarations with their own
 * class-level guards; a route belongs to the innermost class whose lines hold it,
 * and only a class that names a superclass can inherit.
 */
export function collectClassGuardFacts(
  classes: ReadonlyArray<{ node: Node; name: string; guards: GuardAttr[]; /** It names a superclass. */ derived: boolean }>,
  routes: readonly RouteInfo[],
  facts: RouteFact[],
): void {
  const span = (n: Node) => [n.startPosition.row + 1, n.endPosition.row + 1] as const;
  const inner = [...classes].sort((a, b) => span(a.node)[1] - span(a.node)[0] - (span(b.node)[1] - span(b.node)[0]));
  const lines = new Map<string, number[]>();
  for (const r of routes) {
    if (r.kind !== "api") continue;
    const owner = inner.find((c) => r.line >= span(c.node)[0] && r.line <= span(c.node)[1]);
    if (owner && owner.guards.length === 0 && owner.derived) (lines.get(owner.name) ?? lines.set(owner.name, []).get(owner.name)!).push(r.line);
  }
  for (const c of classes) {
    const line = c.node.startPosition.row + 1;
    if (c.guards.length > 0) facts.push({ kind: CLASS_GUARDS, line, owner: c.name, data: { guards: c.guards } satisfies ClassGuardsFact });
    const own = lines.get(c.name);
    if (own?.length) facts.push({ kind: CLASS_ROUTES, line, owner: c.name, data: { lines: [...new Set(own)] } satisfies ClassRoutesFact });
  }
}

export function inheritedClassGuards(id: string, languages: readonly Language[]): RouteResolver {
  return {
    id,
    languages,
    priority: 25,
    resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
      const guarded = new Map<ClassRef, GuardAttr[]>();
      const pending: Array<{ analysis: FileAnalysis; ref: ClassRef; lines: number[] }> = [];
      for (const a of analyses) {
        for (const f of a.routeFacts ?? []) {
          if ((f.kind !== CLASS_GUARDS && f.kind !== CLASS_ROUTES) || !f.owner) continue;
          const ref = ctx.classes.classesIn(a.filePath).find((c) => c.cls.name === f.owner);
          if (!ref) continue;
          if (f.kind === CLASS_GUARDS) guarded.set(ref, (f.data as ClassGuardsFact).guards);
          else pending.push({ analysis: a, ref, lines: (f.data as ClassRoutesFact).lines });
        }
      }
      if (guarded.size === 0 || pending.length === 0) return;
      for (const { analysis, ref, lines } of pending) {
        let guards: GuardAttr[] | undefined;
        const seen = new Set<ClassRef>([ref]);
        for (let cur = ref, depth = 0; depth < 8 && !guards; depth++) {
          const st = ctx.classes.supertypes(cur).find((s) => s.written === cur.cls.extends);
          if (!st?.ref || seen.has(st.ref)) break;
          seen.add(st.ref);
          guards = guarded.get(st.ref);
          cur = st.ref;
        }
        if (!guards) continue;
        const at = new Set(lines);
        analysis.routes = analysis.routes.map((r) => (r.kind === "api" && at.has(r.line) ? withInheritedGuards(r, guards!) : r));
      }
    },
  };
}
