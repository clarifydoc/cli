import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { buildAuth, type GuardAttr } from "../../../shared/route-metadata.js";
import { buildPath, rebindParams, CS_CONTROLLER_FACT, type CsControllerFact, type CsActionFact } from "./aspnet.js";

/** Bases ASP.NET itself provides — reaching one means the chain is fully known. */
const FRAMEWORK_CONTROLLER_BASES = new Set(["Controller", "ControllerBase", "ODataController", "ApiController"]);

/** What a controller inherits along its base chain. */
interface InheritedScope {
  /** The nearest class-level `[Route]` template on the class or an ancestor. */
  template: string | null;
  apiController: boolean;
  /** Class-level guards of the class AND its ancestors, nearest last. */
  guards: GuardAttr[];
  /** A base no project class or framework explains — its template, if any, is unknown. */
  unresolvedBase: string | null;
}

interface Controller {
  analysis: FileAnalysis;
  ref: ClassRef;
  fact: CsControllerFact;
}

/**
 * ASP.NET controller inheritance — what one file cannot see.
 *
 * `[Route("api/[controller]")]` on a base controller (Kavita's
 * `BaseApiController`) is inherited by every controller deriving from it,
 * with `[controller]` naming the DERIVED class; so are `[ApiController]` and
 * `[Authorize]`. Read per file, `SeriesController`'s actions came out
 * prefix-less (`GET /{seriesId}`) — 426 of Kavita's 452 rows — and distinct
 * endpoints with the same tail collapsed into one in dedupe.
 *
 * And a routed action declared on an abstract base (`RestController<T>`'s
 * `[HttpGet("{id}")] GetResourceById`) is served by EVERY concrete subclass,
 * at that subclass's route.
 *
 * Per file, the extractor records each controller's base, own template,
 * `[ApiController]`, own guards and actions (`cs:controller` facts); this
 * pass walks each controller's base chain through the class index and
 * rebuilds what it inherits. A base the chain cannot resolve and ASP.NET does
 * not define leaves the rows marked `prefixUnresolved` — honest, and matched
 * by the linker only as a tail.
 */
export const aspnetControllerInheritance: RouteResolver = {
  id: "aspnet-controller-inheritance",
  languages: ["csharp"],
  priority: 20,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const controllers = new Map<ClassRef, Controller>();
    for (const analysis of analyses) {
      for (const f of analysis.routeFacts ?? []) {
        if (f.kind !== CS_CONTROLLER_FACT || !f.owner) continue;
        const ref = ctx.classes.classesIn(analysis.filePath).find((c) => c.cls.name === f.owner);
        if (ref) controllers.set(ref, { analysis, ref, fact: f.data as CsControllerFact });
      }
    }
    if (controllers.size === 0) return;

    const scopeMemo = new Map<ClassRef, InheritedScope>();
    const scopeOf = (c: Controller): InheritedScope => {
      const cached = scopeMemo.get(c.ref);
      if (cached) return cached;
      const scope: InheritedScope = {
        template: c.fact.template,
        apiController: c.fact.apiController,
        guards: [],
        unresolvedBase: null,
      };
      // Walk the `extends` chain only: implemented interfaces carry no routing.
      let cur: ClassRef = c.ref;
      const seen = new Set<ClassRef>([cur]);
      for (let depth = 0; depth < 8; depth++) {
        const st = ctx.classes.supertypes(cur).find((s) => s.written === cur.cls.extends);
        if (!st) break;
        if (!st.ref) {
          if (!FRAMEWORK_CONTROLLER_BASES.has(st.name) && scope.template === null) scope.unresolvedBase = st.name;
          break;
        }
        if (seen.has(st.ref)) break;
        seen.add(st.ref);
        const base = controllers.get(st.ref);
        if (base) {
          scope.template ??= base.fact.template;
          scope.apiController ||= base.fact.apiController;
          scope.guards.unshift(...base.fact.guards);
        }
        cur = st.ref;
      }
      scopeMemo.set(c.ref, scope);
      return scope;
    };

    /** A row for one action, served under controller `at`, built from the fact. */
    const rowFor = (source: RouteInfo, action: CsActionFact, at: Controller): RouteInfo => {
      const scope = scopeOf(at);
      const controllerToken = at.ref.cls.name.replace(/Controller$/, "");
      const path = buildPath(scope.template, action.template, controllerToken, action.handler);
      const classGuards = [...scope.guards, ...at.fact.guards];
      const row: RouteInfo = {
        ...source,
        path,
        owner: at.ref.cls.name,
        middleware: [...classGuards, ...action.guards].map((g) => g.text),
      };
      const auth = buildAuth(classGuards, action.guards);
      if (auth) row.auth = auth;
      else delete row.auth;
      if (source.params) row.params = rebindParams(source.params, path, scope.apiController);
      if (scope.template === null && scope.unresolvedBase) row.prefixUnresolved = `base:${scope.unresolvedBase}`;
      return row;
    };

    const rowOf = (c: Controller, action: CsActionFact): RouteInfo | undefined =>
      c.analysis.routes.find((r) => r.owner === c.ref.cls.name && r.line === action.line && r.httpMethod === action.verb);

    // 1. Actions a concrete subclass inherits from a base that declares them.
    //    The copy lives in the BASE's file (that is where the handler code is)
    //    and is owned by the subclass it is served under.
    const inheritedRows = new Map<FileAnalysis, RouteInfo[]>();
    const abstractRouted = new Set<Controller>();
    for (const base of controllers.values()) {
      if (base.fact.actions.length === 0) continue;
      const subclasses = ctx.classes.descendants(base.ref).map((r) => controllers.get(r)).filter((c): c is Controller => !!c);
      if (base.fact.abstract) abstractRouted.add(base);
      for (const sub of subclasses) {
        if (sub.fact.abstract) continue;
        const overrides = new Set(sub.ref.cls.methods.map((m) => m.name));
        for (const action of base.fact.actions) {
          if (action.handler && overrides.has(action.handler)) continue;
          const source = rowOf(base, action);
          if (!source) continue;
          const list = inheritedRows.get(base.analysis) ?? [];
          list.push(rowFor(source, action, sub));
          inheritedRows.set(base.analysis, list);
        }
      }
    }

    // 2. Each controller's own rows, under what it inherits.
    for (const c of controllers.values()) {
      const scope = scopeOf(c);
      const inheritsSomething =
        (c.fact.template === null && (scope.template !== null || scope.unresolvedBase !== null)) ||
        scope.guards.length > 0 ||
        scope.apiController !== c.fact.apiController;
      if (!inheritsSomething || c.fact.actions.length === 0) continue;
      c.analysis.routes = c.analysis.routes.map((r) => {
        if (r.owner !== c.ref.cls.name) return r;
        const action = c.fact.actions.find((a) => a.line === r.line && a.verb === r.httpMethod);
        return action ? rowFor(r, action, c) : r;
      });
    }

    // 3. An abstract controller is never routed itself; its subclasses serve its actions.
    for (const base of abstractRouted) {
      base.analysis.routes = base.analysis.routes.filter((r) => r.owner !== base.ref.cls.name);
    }
    for (const [analysis, rows] of inheritedRows) analysis.routes = [...analysis.routes, ...rows];
  },
};
