import type { FileAnalysis, FunctionInfo, RouteInfo } from "../../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import {
  DJ_ROOT_URLCONF,
  DJ_URLPATTERNS,
  DJ_VIEW_CLASS,
  DRF_REGISTER,
  DRF_ROUTER,
  type DjViewClassFact,
  type DrfRegisterFact,
  type DrfRouterFact,
  type UrlEntry,
  type ViewRef,
} from "./facts.js";
import { djangoRoute, joinDjango } from "./paths.js";

const VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** DRF's router: which action serves which method on the list URL and on the detail URL. */
const LIST_ACTIONS: Record<string, string> = { list: "GET", create: "POST" };
const DETAIL_ACTIONS: Record<string, string> = { retrieve: "GET", update: "PUT", partial_update: "PATCH", destroy: "DELETE" };

/** Actions a framework base provides without the project writing them. */
const BASE_ACTIONS: Record<string, string[]> = {
  ModelViewSet: ["list", "create", "retrieve", "update", "partial_update", "destroy"],
  ReadOnlyModelViewSet: ["list", "retrieve"],
  ListModelMixin: ["list"],
  CreateModelMixin: ["create"],
  RetrieveModelMixin: ["retrieve"],
  UpdateModelMixin: ["update", "partial_update"],
  DestroyModelMixin: ["destroy"],
};

/** Methods a framework generic view answers. */
const GENERIC_VIEW_METHODS: Record<string, string[]> = {
  ListAPIView: ["GET"],
  RetrieveAPIView: ["GET"],
  CreateAPIView: ["POST"],
  DestroyAPIView: ["DELETE"],
  UpdateAPIView: ["PUT", "PATCH"],
  ListCreateAPIView: ["GET", "POST"],
  RetrieveUpdateAPIView: ["GET", "PUT", "PATCH"],
  RetrieveDestroyAPIView: ["GET", "DELETE"],
  RetrieveUpdateDestroyAPIView: ["GET", "PUT", "PATCH", "DELETE"],
  TemplateView: ["GET"],
  ListView: ["GET"],
  DetailView: ["GET"],
  RedirectView: ["GET"],
  FormView: ["GET", "POST"],
  CreateView: ["GET", "POST"],
  UpdateView: ["GET", "POST"],
  DeleteView: ["GET", "POST"],
  LoginView: ["GET", "POST"],
  LogoutView: ["GET", "POST"],
};

interface Where {
  analysis: FileAnalysis;
  line: number;
}

/**
 * Django urlconfs and Django REST Framework routers, joined across files.
 *
 * A urlconf entry's path is a PREFIX of whatever includes it (`re_path("^api/",
 * include([...]))`, `path("api/dcim/", include("dcim.api.urls"))`), a DRF
 * `router.register("tags", TagViewSet)` becomes up to six routes plus one per
 * `@action` — which depend on the ViewSet's bases, usually in another file.
 * ClarifyDoc read none of it: paperless-ngx (20 registered ViewSets, nested
 * `re_path` includes) had no API route at all.
 *
 * The walk starts at `ROOT_URLCONF`'s module, or at every urlconf nothing
 * includes; one no root reaches is still emitted, marked
 * `prefixUnresolved: urlconf:not-included`. A non-literal route
 * (`path(settings.BASE_PATH, …)`) contributes nothing to the path and marks
 * what is below it. Handlers are `DefiningClass.method` where the project
 * declares the method, so params and symbol links bind; a framework-provided
 * action (`TagViewSet.list`) is anchored on the ViewSet's class line.
 */
export const djangoUrlconfResolver: RouteResolver = {
  id: "django-urlconf",
  languages: ["python"],
  priority: 30,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const urlconfs = new Map<string, Map<string, UrlEntry[]>>(); // file → var → entries
    const routers = new Map<string, Map<string, { router?: DrfRouterFact; registers: Array<DrfRegisterFact & { line: number }> }>>();
    const viewFacts = new Map<string, DjViewClassFact>(); // `${file}::${class}`
    const roots: string[] = [];
    let any = false;
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === DJ_URLPATTERNS && f.owner) {
          any = true;
          const vars = urlconfs.get(a.filePath) ?? new Map<string, UrlEntry[]>();
          vars.set(f.owner, [...(vars.get(f.owner) ?? []), ...(f.data as { entries: UrlEntry[] }).entries]);
          urlconfs.set(a.filePath, vars);
        } else if (f.kind === DRF_ROUTER || f.kind === DRF_REGISTER) {
          const byVar = routers.get(a.filePath) ?? new Map();
          const entry = byVar.get(f.owner!) ?? { registers: [] };
          if (f.kind === DRF_ROUTER) entry.router = f.data as DrfRouterFact;
          else entry.registers.push({ ...(f.data as DrfRegisterFact), line: f.line });
          byVar.set(f.owner!, entry);
          routers.set(a.filePath, byVar);
        } else if (f.kind === DJ_VIEW_CLASS && f.owner) {
          viewFacts.set(`${a.filePath}::${f.owner}`, f.data as DjViewClassFact);
        } else if (f.kind === DJ_ROOT_URLCONF) {
          const file = ctx.resolveModule(a.filePath, (f.data as { module: string }).module);
          if (file) roots.push(file);
        }
      }
    }
    if (!any) return;

    const added = new Map<FileAnalysis, RouteInfo[]>();
    const emit = (where: Where, row: Omit<RouteInfo, "line" | "calls" | "middleware"> & { middleware?: string[] }) => {
      const list = added.get(where.analysis) ?? [];
      list.push({ calls: [], middleware: [], ...row, line: where.line });
      added.set(where.analysis, list);
    };

    // ── Which urlconfs are reached from where ──
    const included = new Set<string>();
    const collectIncludes = (file: string, entries: UrlEntry[]) => {
      for (const e of entries) {
        if (e.t !== "include") continue;
        if (e.target.kind === "module") {
          const target = ctx.resolveModule(file, e.target.spec);
          if (target) included.add(target);
        } else if (e.target.kind === "list") collectIncludes(file, e.target.entries);
      }
    };
    for (const [file, vars] of urlconfs) for (const entries of vars.values()) collectIncludes(file, entries);
    const starts = roots.length > 0 ? roots : [...urlconfs.keys()].filter((f) => !included.has(f));
    const visited = new Set<string>();

    // ── View resolution ──
    const classChain = (ref: ClassRef): ClassRef[] => [ref, ...ctx.classes.ancestors(ref).flatMap((s) => (s.ref ? [s.ref] : []))];
    const externalBases = (ref: ClassRef): string[] => ctx.classes.ancestors(ref).filter((s) => !s.ref).map((s) => s.name);
    const nearestFact = (ref: ClassRef): DjViewClassFact => {
      const merged: DjViewClassFact = {};
      for (const c of classChain(ref).reverse()) Object.assign(merged, viewFacts.get(`${c.filePath}::${c.cls.name}`) ?? {});
      return merged;
    };
    /** The project method of this name on the class or its nearest ancestor. */
    const methodOf = (ref: ClassRef, name: string): { owner: ClassRef; fn: FunctionInfo } | null => {
      for (const c of classChain(ref)) {
        const fn = c.cls.methods.find((m) => m.name === name);
        if (fn) return { owner: c, fn };
      }
      return null;
    };
    const whereClass = (ref: ClassRef): Where | null => {
      const a = ctx.fileOf(ref.filePath);
      return a ? { analysis: a, line: ref.cls.line } : null;
    };
    const whereMethod = (m: { owner: ClassRef; fn: FunctionInfo }): Where | null => {
      const a = ctx.fileOf(m.owner.filePath);
      return a ? { analysis: a, line: m.fn.line } : null;
    };
    /**
     * DRF's `permission_classes` first (the class says it outright); else
     * Django's own guards: an auth mixin among the external bases
     * (`LoginRequiredMixin`), or a `method_decorator(login_required)` on the
     * class or its `dispatch`.
     */
    const authOf = (fact: DjViewClassFact, ref?: ClassRef): Partial<Pick<RouteInfo, "auth" | "middleware">> => {
      const perms = fact.permissionClasses;
      if (perms) {
        return {
          middleware: perms,
          auth: { policies: perms, roles: [], schemes: [], anonymous: perms.length === 0 || perms.includes("AllowAny"), inherited: true },
        };
      }
      if (!ref) return {};
      const mixins = externalBases(ref).filter((b) => AUTH_MIXINS.has(b));
      const decorators = classChain(ref).flatMap((c) => [
        ...(c.cls.decorators ?? []),
        ...(c.cls.methods.find((m) => m.name === "dispatch")?.decorators ?? []),
      ]);
      return guardAuth([...mixins, ...decoratorGuards(decorators)], true);
    };

    /** A function view's guards, read off its decorators wherever the urlconf imports it from. */
    const funcAuth = (urlconfFile: string, name: string): Partial<Pick<RouteInfo, "auth" | "middleware">> => {
      const parts = name.split(".");
      const fn = parts.pop()!;
      const file = parts.length > 0
        ? (ctx.importIndex.localFor(urlconfFile, parts[0]!) ?? ctx.resolveModule(urlconfFile, parts.join(".")))
        : (ctx.importIndex.localFor(urlconfFile, fn) ?? urlconfFile);
      const def = file ? ctx.fileOf(file)?.functions.find((f) => f.name === fn) : undefined;
      return def ? guardAuth(decoratorGuards(def.decorators ?? []), false) : {};
    };

    const emitView = (file: string, path: string, view: ViewRef, line: number, marker: string | undefined) => {
      const urlconf = ctx.fileOf(file);
      if (!urlconf) return;
      const ref = view.kind === "class" ? ctx.classes.resolve(file, view.name) : null;
      const extra = marker ? { prefixUnresolved: marker } : {};
      if (!ref) {
        // A function view, or a class we cannot see: a route at that path, any method.
        const auth = view.kind === "func" ? funcAuth(file, view.name) : {};
        emit({ analysis: urlconf, line }, { path, httpMethod: null, kind: "api", handler: view.name, ...auth, ...extra });
        return;
      }
      const auth = authOf(nearestFact(ref), ref);
      if (view.kind === "class" && view.actions) {
        for (const [verb, action] of Object.entries(view.actions)) {
          const m = methodOf(ref, action);
          const where = (m && whereMethod(m)) ?? whereClass(ref);
          if (where) emit(where, { path, httpMethod: verb.toUpperCase(), kind: "api", handler: `${(m?.owner ?? ref).cls.name}.${action}`, ...auth, ...extra });
        }
        return;
      }
      let emitted = false;
      for (const verb of VERBS) {
        const m = methodOf(ref, verb);
        if (!m) continue;
        const where = whereMethod(m);
        if (where) emit(where, { path, httpMethod: verb.toUpperCase(), kind: "api", handler: `${m.owner.cls.name}.${verb}`, ...auth, ...extra });
        emitted = true;
      }
      if (emitted) return;
      const methods = [...new Set(externalBases(ref).flatMap((b) => GENERIC_VIEW_METHODS[b] ?? []))];
      const where = whereClass(ref);
      if (!where) return;
      if (methods.length === 0) emit(where, { path, httpMethod: null, kind: "api", handler: ref.cls.name, ...auth, ...extra });
      for (const m of methods) emit(where, { path, httpMethod: m, kind: "api", handler: ref.cls.name, ...auth, ...extra });
    };

    const expandRegistration = (file: string, base: string, reg: DrfRegisterFact & { line: number }, slash: boolean, marker: string | undefined) => {
      const ref = ctx.classes.resolve(file, reg.viewset);
      const urlconf = ctx.fileOf(file);
      const extra = marker ? { prefixUnresolved: marker } : {};
      const ts = slash ? "/" : "";
      const prefix = reg.prefix.replace(/^\^|\/?\$$/g, "");
      const listPath = joinDjango(base, prefix, ts);
      if (!ref) {
        if (urlconf) emit({ analysis: urlconf, line: reg.line }, { path: listPath, httpMethod: null, kind: "api", handler: reg.viewset, ...extra });
        return;
      }
      const fact = nearestFact(ref);
      const lookup = fact.lookupUrlKwarg ?? fact.lookupField ?? "pk";
      const detailPath = joinDjango(base, prefix, `/{${lookup}}`, ts);
      const allowed = fact.httpMethodNames ? new Set(fact.httpMethodNames.map((m) => m.toUpperCase())) : null;
      const auth = authOf(fact, ref);
      const provided = new Set(externalBases(ref).flatMap((b) => BASE_ACTIONS[b] ?? []));
      const route = (path: string, method: string, action: string) => {
        if (allowed && !allowed.has(method)) return;
        const m = methodOf(ref, action);
        if (!m && !provided.has(action)) return;
        const where = (m && whereMethod(m)) ?? whereClass(ref);
        if (where) {
          emit(where, { path, httpMethod: method, kind: "api", handler: `${(m?.owner ?? ref).cls.name}.${action}`, owner: ref.cls.name, ...auth, ...extra });
        }
      };
      for (const [action, method] of Object.entries(LIST_ACTIONS)) route(listPath, method, action);
      for (const [action, method] of Object.entries(DETAIL_ACTIONS)) route(detailPath, method, action);

      // `@action(detail=…, methods=[…], url_path=…)` and `@x.mapping.<verb>` along the class chain.
      const seen = new Set<string>();
      for (const c of classChain(ref)) {
        for (const fn of c.cls.methods) {
          if (seen.has(fn.name)) continue;
          for (const d of fn.decorators ?? []) {
            const act = parseAction(d);
            if (!act) continue;
            seen.add(fn.name);
            const urlPath = djangoRoute(act.urlPath ?? fn.name, true).replace(/^\/|\/$/g, "");
            const path = act.detail
              ? joinDjango(base, prefix, `/{${lookup}}/`, urlPath, ts)
              : joinDjango(base, prefix, "/", urlPath, ts);
            const where = whereMethod({ owner: c, fn });
            for (const method of act.methods) {
              if (where) emit(where, { path, httpMethod: method, kind: "api", handler: `${c.cls.name}.${fn.name}`, owner: ref.cls.name, ...auth, ...extra });
            }
            // `@<action>.mapping.patch def other(…)`: another method on the same URL.
            for (const other of c.cls.methods) {
              for (const od of other.decorators ?? []) {
                const mapped = new RegExp(`^${fn.name}\\.mapping\\.(\\w+)$`).exec(od.trim());
                const w = mapped ? whereMethod({ owner: c, fn: other }) : null;
                if (mapped && w) emit(w, { path, httpMethod: mapped[1]!.toUpperCase(), kind: "api", handler: `${c.cls.name}.${other.name}`, owner: ref.cls.name, ...auth, ...extra });
              }
            }
          }
        }
      }
    };

    const routerIn = (file: string, name: string) => {
      const local = routers.get(file)?.get(name);
      if (local) return { file, entry: local };
      const source = ctx.importIndex.localFor(file, name);
      const imported = source ? routers.get(source)?.get(name) : undefined;
      return imported && source ? { file: source, entry: imported } : null;
    };

    const walk = (file: string, entries: UrlEntry[], prefix: string, marker: string | undefined, depth: number) => {
      if (depth > 12) return;
      for (const e of entries) {
        if (e.t === "router") {
          const r = routerIn(file, e.name);
          for (const reg of r?.entry.registers ?? []) expandRegistration(r!.file, prefix, reg, r!.entry.router?.trailingSlash ?? true, marker);
          continue;
        }
        const segment = e.route === null ? "" : djangoRoute(e.route, e.regex);
        const nextMarker = marker ?? (e.route === null ? "urlconf:dynamic-prefix" : undefined);
        const path = prefix + segment;
        if (e.t === "view") {
          emitView(file, joinDjango(path), e.view, e.line, nextMarker);
          continue;
        }
        const t = e.target;
        if (t.kind === "list") walk(file, t.entries, path, nextMarker, depth + 1);
        else if (t.kind === "module") {
          const target = ctx.resolveModule(file, t.spec);
          const conf = target ? urlconfs.get(target)?.get("urlpatterns") : undefined;
          if (target && conf) {
            visited.add(target);
            walk(target, conf, path, nextMarker, depth + 1);
          }
        } else if (t.kind === "var") {
          const local = urlconfs.get(file)?.get(t.name);
          const source = local ? file : ctx.importIndex.localFor(file, t.name);
          const conf = local ?? (source ? urlconfs.get(source)?.get(t.name) : undefined);
          if (conf && source) walk(source, conf, path, nextMarker, depth + 1);
        } else if (t.kind === "router") {
          const r = routerIn(file, t.name);
          for (const reg of r?.entry.registers ?? []) expandRegistration(r!.file, path, reg, r!.entry.router?.trailingSlash ?? true, nextMarker);
        }
      }
    };

    for (const start of starts) {
      const conf = urlconfs.get(start)?.get("urlpatterns");
      if (!conf) continue;
      visited.add(start);
      walk(start, conf, "", undefined, 0);
    }
    // A urlconf with routes no root reaches: its paths are a tail of what callers request.
    for (const [file, vars] of urlconfs) {
      const conf = vars.get("urlpatterns");
      if (conf && !visited.has(file) && !included.has(file)) walk(file, conf, "", "urlconf:not-included", 0);
    }

    for (const [analysis, rows] of added) analysis.routes = [...analysis.routes, ...dedupe(rows)];
  },
};

/** Same method + path + handler emitted twice (a router reached from two includes) is one row. */
function dedupe(rows: RouteInfo[]): RouteInfo[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.httpMethod} ${r.path} ${r.handler} ${r.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `action(detail=True, methods=["get", "post"], url_path=r"versions/(?P<id>\d+)")` → its parts. */
export function parseAction(decorator: string): { detail: boolean; methods: string[]; urlPath: string | null } | null {
  const text = decorator.replace(/\s+/g, " ").trim();
  if (!/^(?:[\w.]+\.)?action\b/.test(text)) return null;
  const detail = /detail\s*=\s*True/.test(text);
  const methodsMatch = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(text);
  const methods = methodsMatch
    ? [...methodsMatch[1]!.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!.toUpperCase())
    : ["GET"];
  const urlPath = /url_path\s*=\s*[rbu]*(["'])(.*?)\1/.exec(text)?.[2] ?? null;
  return { detail, methods: methods.length ? methods : ["GET"], urlPath };
}

/** Django's auth mixins: a class-based view with one in its bases requires a signed-in user. */
const AUTH_MIXINS = new Set(["LoginRequiredMixin", "PermissionRequiredMixin", "UserPassesTestMixin"]);

/** View decorators that guard a view (`login_not_required`, Django 5.1, opens one under LoginRequiredMiddleware). */
const GUARD_DECORATOR = /^(?:[\w.]+\.)?(login_required|permission_required|user_passes_test|staff_member_required|superuser_required|login_not_required|permission_classes)\b(\([^)]*\))?/;

/**
 * The guards a list of decorators states, as written (`login_required`,
 * `permission_required("shop.change_order")`, DRF's
 * `permission_classes([IsAuthenticated])` → `IsAuthenticated`), unwrapping
 * `method_decorator(…)`. `login_not_required` comes back as itself.
 */
function decoratorGuards(decorators: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of decorators) {
    const text = raw.replace(/^@/, "").replace(/^(?:[\w.]+\.)?method_decorator\(\s*/, "");
    const m = GUARD_DECORATOR.exec(text);
    if (!m) continue;
    if (m[1] === "permission_classes") {
      const inner = /\[([^\]]*)\]|\(([^)]*)\)/.exec(m[2] ?? "");
      out.push(...(inner?.[1] ?? inner?.[2] ?? "").split(",").map((p) => p.trim().replace(/^[[(]|[\])]$/g, "")).filter(Boolean));
    } else {
      out.push(m[1] === "login_required" || m[1] === "login_not_required" ? m[1] : `${m[1]}${m[2] ?? ""}`);
    }
  }
  return out;
}

/** Guards as a route's `auth` + `middleware`; nothing when there are none. */
function guardAuth(guards: string[], inherited: boolean): Partial<Pick<RouteInfo, "auth" | "middleware">> {
  if (guards.length === 0) return {};
  const policies = guards.filter((g) => g !== "login_not_required" && g !== "AllowAny");
  return {
    middleware: guards,
    auth: { policies, roles: [], schemes: [], anonymous: policies.length === 0, inherited },
  };
}
