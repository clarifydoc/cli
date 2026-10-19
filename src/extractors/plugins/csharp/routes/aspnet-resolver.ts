import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { buildAuth, type GuardAttr } from "../../../shared/route-metadata.js";
import { buildPath, rebindParams, CS_CONTROLLER_FACT, type CsControllerFact, type CsActionFact } from "./aspnet.js";
import { CustomAttributes } from "./aspnet-attributes.js";
import { areaOfPath, conventionalPath, webApiVerb, CS_CONVENTIONAL_ROUTE_FACT, type CsConventionalPattern } from "./aspnet-conventional.js";

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
  /** A project routing attribute whose template could not be evaluated. */
  unresolvedAttr: string | null;
  /** The framework base the chain ends at (`Controller`, Web API 2's `ApiController`). */
  frameworkBase: string | null;
}

/** A controller fact with the project's own routing attributes applied. */
interface EffectiveFact extends CsControllerFact {
  /** The class-level project attribute that provides a template no evaluation could state. */
  unresolvedAttr: string | null;
  /** Actions routed only by a project attribute — no row exists for them yet. */
  synthetic: CsActionFact[];
}

interface Controller {
  analysis: FileAnalysis;
  ref: ClassRef;
  /** What the extractor saw — the rows it built used these. */
  raw: CsControllerFact;
  fact: EffectiveFact;
}

/**
 * Apply project routing attributes (`[V3ApiController]`, `[RestPutById]`) to
 * a controller's fact: the class template and `[ApiController]` behaviour
 * they provide, and one action per verb a candidate method's attribute names.
 */
function effectiveFact(raw: CsControllerFact, filePath: string, attrs: CustomAttributes): EffectiveFact {
  const fact: EffectiveFact = { ...raw, unresolvedAttr: null, synthetic: [] };
  if (attrs.empty) return fact;
  for (const use of raw.attrs ?? []) {
    const m = attrs.meaning(filePath, use);
    if (!m) continue;
    fact.apiController ||= m.apiController;
    if (fact.template !== null) continue;
    if (m.template !== null) fact.template = m.template;
    else if (m.templateUnknown) fact.unresolvedAttr ??= use.name;
  }
  for (const c of raw.candidates ?? []) {
    for (const use of c.attrs) {
      const m = attrs.meaning(filePath, use);
      // A verb with a template no evaluation could state would be a guessed path: refuse it.
      if (!m || m.verbs.length === 0 || m.templateUnknown) continue;
      for (const verb of m.verbs) {
        fact.synthetic.push({ line: use.line, verb, handler: c.handler, template: m.template, guards: c.guards });
      }
    }
  }
  if (fact.synthetic.length > 0) fact.actions = [...raw.actions, ...fact.synthetic];
  return fact;
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
    const attrs = new CustomAttributes(analyses, ctx);
    const controllers = new Map<ClassRef, Controller>();
    for (const analysis of analyses) {
      for (const f of analysis.routeFacts ?? []) {
        if (f.kind !== CS_CONTROLLER_FACT || !f.owner) continue;
        const ref = ctx.classes.classesIn(analysis.filePath).find((c) => c.cls.name === f.owner);
        if (!ref) continue;
        const raw = f.data as CsControllerFact;
        controllers.set(ref, { analysis, ref, raw, fact: effectiveFact(raw, analysis.filePath, attrs) });
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
        unresolvedAttr: c.fact.unresolvedAttr,
        frameworkBase: null,
      };
      // Walk the `extends` chain only: implemented interfaces carry no routing.
      let cur: ClassRef = c.ref;
      const seen = new Set<ClassRef>([cur]);
      for (let depth = 0; depth < 8; depth++) {
        const st = ctx.classes.supertypes(cur).find((s) => s.written === cur.cls.extends);
        if (!st) break;
        if (!st.ref) {
          if (FRAMEWORK_CONTROLLER_BASES.has(st.name)) scope.frameworkBase = st.name;
          else if (scope.template === null) scope.unresolvedBase = st.name;
          break;
        }
        if (seen.has(st.ref)) break;
        seen.add(st.ref);
        const base = controllers.get(st.ref);
        if (base) {
          if (scope.template === null && scope.unresolvedAttr === null) {
            scope.template = base.fact.template;
            scope.unresolvedAttr = base.fact.unresolvedAttr;
          }
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
      if (scope.template === null && scope.unresolvedAttr) row.prefixUnresolved = `attribute:${scope.unresolvedAttr}`;
      else if (scope.template === null && scope.unresolvedBase) row.prefixUnresolved = `base:${scope.unresolvedBase}`;
      return row;
    };

    const rowOf = (c: Controller, action: CsActionFact): RouteInfo | undefined =>
      c.analysis.routes.find((r) => r.owner === c.ref.cls.name && r.line === action.line && r.httpMethod === action.verb);

    // 0. Rows for actions only a project attribute routes. Built at their own
    //    controller here; inherited copies and own-row rewrites follow.
    for (const c of controllers.values()) {
      for (const action of c.fact.synthetic) {
        const candidate = c.raw.candidates?.find((k) => k.handler === action.handler && k.attrs.some((a) => a.line === action.line));
        const source: RouteInfo = {
          path: "/",
          httpMethod: action.verb,
          kind: "api",
          handler: action.handler,
          calls: [],
          middleware: [],
          line: action.line,
          owner: c.ref.cls.name,
        };
        if (candidate?.params) source.params = candidate.params;
        if (candidate?.versions) source.versions = candidate.versions;
        if (candidate?.deprecatedVersions) source.deprecatedVersions = candidate.deprecatedVersions;
        c.analysis.routes = [...c.analysis.routes, rowFor(source, action, c)];
      }
    }

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
      // The extractor built these rows from the raw fact; rebuild them when
      // the scope says otherwise.
      const stale =
        scope.template !== c.raw.template ||
        (scope.template === null && (scope.unresolvedBase !== null || scope.unresolvedAttr !== null)) ||
        scope.guards.length > 0 ||
        scope.apiController !== c.raw.apiController;
      if (!stale || c.fact.actions.length === 0) continue;
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

    // 4. Controllers no attribute routes: the startup's conventional route table.
    applyConventionalRoutes(analyses, controllers.values(), scopeOf);
  },
};

/** One registered pattern, with where it was registered. */
interface Registered extends CsConventionalPattern {
  file: string;
}

/**
 * ASP.NET conventional routing. A controller that neither it nor an ancestor
 * attribute-routes (no class template, no `[ApiController]`) is reached
 * through the patterns its sub-project registers, tried in order — the first
 * that serves the controller's area (`[Area]`, or an MVC 5 `Areas/X/` folder)
 * names the path. Its public actions become rows (any verb, unless a verb
 * attribute narrows it; Web API 2 takes the verb the name starts with), and a
 * verb-attributed action the extractor could only place at `/` moves to its
 * conventional path. No registered pattern: nothing is invented.
 */
function applyConventionalRoutes(
  analyses: FileAnalysis[],
  controllers: Iterable<Controller>,
  scopeOf: (c: Controller) => InheritedScope,
): void {
  const byProject = new Map<string, Registered[]>();
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind !== CS_CONVENTIONAL_ROUTE_FACT) continue;
      const list = byProject.get(a.projectId) ?? [];
      list.push({ ...(f.data as CsConventionalPattern), file: a.filePath });
      byProject.set(a.projectId, list);
    }
  }
  if (byProject.size === 0) return;

  for (const c of controllers) {
    const patterns = byProject.get(c.analysis.projectId);
    if (!patterns || c.fact.abstract) continue;
    const scope = scopeOf(c);
    if (scope.template !== null || scope.unresolvedAttr !== null || scope.apiController) continue;
    const webApi = scope.frameworkBase === "ApiController";
    const area = c.raw.area ?? areaOfPath(c.analysis.filePath);
    const pattern = patterns.find((p) => !!p.webApi === webApi && servesArea(p, area));
    if (!pattern) continue;
    const controllerToken = c.ref.cls.name.replace(/Controller$/, "");
    const paramsOf = (handler: string | null): string[] =>
      c.ref.cls.methods.find((m) => m.name === handler)?.params.map((p) => p.name) ?? [];
    const classGuards = [...scope.guards, ...c.fact.guards];

    // Verb-attributed actions with no template of their own.
    c.analysis.routes = c.analysis.routes.map((r) => {
      if (r.owner !== c.ref.cls.name) return r;
      const action = c.fact.actions.find((a) => a.line === r.line && a.verb === r.httpMethod);
      if (!action || action.template !== null) return r;
      const path = conventionalPath(pattern, controllerToken, action.action ?? action.handler, area, paramsOf(action.handler));
      if (!path) return r;
      const row: RouteInfo = { ...r, path };
      if (r.params) row.params = rebindParams(r.params, path, false);
      return row;
    });

    // Plain public actions: no row yet (an overload of the same name may have
    // one — MVC's GET form and its [HttpPost] submit are two actions).
    const added: RouteInfo[] = [];
    for (const action of c.raw.conventional ?? []) {
      if (c.fact.synthetic.some((s) => s.handler === action.handler)) continue;
      const path = conventionalPath(pattern, controllerToken, webApi ? null : action.action, area, paramsOf(action.handler));
      if (!path) continue;
      const row: RouteInfo = {
        path,
        httpMethod: webApi ? webApiVerb(action.handler) : null,
        kind: "api",
        handler: action.handler,
        calls: [],
        middleware: [...classGuards, ...action.guards].map((g) => g.text),
        line: action.line,
        owner: c.ref.cls.name,
      };
      const auth = buildAuth(classGuards, action.guards);
      if (auth) row.auth = auth;
      if (action.params) row.params = rebindParams(action.params, path, false);
      added.push(row);
    }
    if (added.length > 0) c.analysis.routes = [...c.analysis.routes, ...added];
  }
}

/** A pattern serves a controller of `area` (null: none) — by its area name, an `{area}` token, or the `Areas/X/` folder it is registered in. */
function servesArea(p: Registered, area: string | null): boolean {
  const own = p.area ?? areaOfPath(p.file);
  const token = /\{area\b/i.test(p.pattern);
  if (area) return token || (own !== null && own.toLowerCase() === area.toLowerCase());
  return !token && own === null;
}
