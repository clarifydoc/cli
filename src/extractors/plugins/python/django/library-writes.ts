import type { DataSourceInfo, FileAnalysis } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { type ClassAt, declaredAlong, DRF_GENERIC_VIEW, PythonClassIndex } from "./drf.js";
import type { UrlEntry } from "./facts.js";
import { serializerSites } from "./serializer-dispatch.js";
import { routeSymbolName } from "../../../../core/route-symbol.js";

/**
 * The tables DRF's own code writes where the project writes no code of its own.
 *
 * `router.register("clubs", ClubViewSet)` over a `ModelViewSet` that overrides nothing serves `POST /clubs/`
 * with the library's `create`, which saves through the view's serializer into the model its `queryset`
 * names: the route writes that table, though no project line says so. The same goes for `update`,
 * `partial_update` and `destroy`, for a generic view's `POST`/`PUT`/`PATCH`/`DELETE`
 * (`CreateAPIView`), and for a project override that hands on with `super().create(…)`.
 *
 * Likewise a `ModelSerializer` whose `create` / `update` the project does not override: `serializer.save()` in
 * a function writes the `Meta.model` table (`serializerSites` says which calls are such saves).
 *
 * Both are stated as `database` rows the route / function owns (`DataSourceInfo.handler` naming the route's
 * anchor, or the call's own line), with `access: "write"`, so the data flows say `db-write`. A `queryset` or
 * `Meta.model` the project does not state, a `get_serializer_class` picking one at run time, or a serializer
 * with an own `create`/`update` (its body's accesses count) adds nothing.
 */

/**
 * django-allauth's own views, which a urlconf routes to by name (`path("accounts/signup/", SignupView.as_view())`,
 * `allauth_account_views.login`, or `include("allauth.urls")` / `include("allauth.account.urls")`): the project
 * writes none of their code, and they act on the user model — signing up creates the user, a password change /
 * set / reset saves it, a login and a reset request look it up. A table of what the library is known to do per
 * view; a view it does not list (`logout`, the e-mail and social views) adds nothing. The module must be
 * allauth's own: a project module of another name, a project class named `SignupView`, or a project that vendors
 * `allauth/account/views.py`, is never one of these.
 */
const ALLAUTH_ACCOUNT_VIEWS: Record<string, { name: string; access: "read" | "write" }> = {
  login: { name: "login", access: "read" },
  LoginView: { name: "login", access: "read" },
  signup: { name: "signup", access: "write" },
  SignupView: { name: "signup", access: "write" },
  password_change: { name: "password change", access: "write" },
  PasswordChangeView: { name: "password change", access: "write" },
  password_set: { name: "password set", access: "write" },
  PasswordSetView: { name: "password set", access: "write" },
  password_reset: { name: "password reset request", access: "read" },
  PasswordResetView: { name: "password reset request", access: "read" },
  password_reset_from_key: { name: "password reset", access: "write" },
  PasswordResetFromKeyView: { name: "password reset", access: "write" },
};
const ALLAUTH_USER_MODEL = "User";
const ALLAUTH_VIEWS_MODULE = "allauth.account.views";
/** `include("allauth.urls")` mounts account urls at ""; `include("allauth.account.urls")` is the same table. */
const ALLAUTH_URLCONF_SPECS = new Set(["allauth.urls", "allauth.account.urls"]);

/**
 * The account routes under a library allauth urlconf that act on the user model (not logout / e-mail / social).
 * Handlers are fully-qualified so `allauthLibraryAccess` recognises them without an import in the urlconf.
 */
const ALLAUTH_ACCOUNT_URLS: Array<{ route: string; view: string; name: string }> = [
  { route: "login/", view: "login", name: "account_login" },
  { route: "signup/", view: "signup", name: "account_signup" },
  { route: "password/change/", view: "password_change", name: "account_change_password" },
  { route: "password/set/", view: "password_set", name: "account_set_password" },
  { route: "password/reset/", view: "password_reset", name: "account_reset_password" },
  { route: "password/reset/key/<uidb36>-<key>/", view: "password_reset_from_key", name: "account_reset_password_from_key" },
];

/**
 * Urlconf entries for a known library module the project does not ship. The urlconf walker calls this when
 * `include("allauth.urls")` (or `allauth.account.urls`) resolves to no project file — a project that vendors
 * allauth is walked as its own urlconf instead. `line` is the include's.
 */
export function libraryUrlconfEntries(spec: string, line: number): UrlEntry[] | null {
  if (!ALLAUTH_URLCONF_SPECS.has(spec)) return null;
  return ALLAUTH_ACCOUNT_URLS.map(({ route, view, name }) => ({
    t: "view",
    route,
    regex: false,
    line,
    view: { kind: "func", name: `${ALLAUTH_VIEWS_MODULE}.${view}` },
    name,
  }));
}

/** The allauth account view a route's handler names through an import or a library include expansion, else null. */
function allauthAccountView(a: FileAnalysis, handler: string, projectFiles: ReadonlySet<string>): { name: string; access: "read" | "write" } | null {
  if (projectFiles.has("allauth/account/views.py")) return null;
  // `include("allauth.urls")` expansion: handler is `allauth.account.views.login`.
  if (handler.startsWith(`${ALLAUTH_VIEWS_MODULE}.`)) {
    const view = handler.slice(ALLAUTH_VIEWS_MODULE.length + 1);
    return view.includes(".") ? null : (ALLAUTH_ACCOUNT_VIEWS[view] ?? null);
  }
  const [head, ...rest] = handler.split(".");
  if (!head || rest.length > 1) return null;
  const imp = a.imports.find((i) => !i.isType && (i.specifiers.includes(head) || i.aliases?.[head] !== undefined));
  if (!imp) return null;
  const exported = imp.aliases?.[head] ?? head;
  // `from allauth.account import views as v` + `v.login`, or `from allauth.account.views import SignupView` + `SignupView`.
  const module = rest.length === 1 ? `${imp.source}.${exported}` : imp.source;
  const view = rest.length === 1 ? rest[0]! : exported;
  if (module !== ALLAUTH_VIEWS_MODULE) return null;
  return ALLAUTH_ACCOUNT_VIEWS[view] ?? null;
}

export const allauthLibraryAccess: RouteResolver = {
  id: "allauth-library-access",
  languages: ["python"],
  priority: 32,
  resolve(analyses: FileAnalysis[], _ctx: ProjectContext): void {
    const mentionsAllauth = analyses.some((a) =>
      a.imports.some((i) => i.source === "allauth.account" || i.source === "allauth.account.views")
      || a.routes.some((r) => r.handler?.startsWith(`${ALLAUTH_VIEWS_MODULE}.`)));
    if (!mentionsAllauth) return;
    const projectFiles = new Set(analyses.map((a) => a.filePath));
    for (const a of analyses) {
      for (const r of a.routes) {
        if (r.kind !== "api" || r.mount || !r.handler) continue;
        const view = allauthAccountView(a, r.handler, projectFiles);
        if (!view) continue;
        addRow(a, {
          kind: "database", name: `allauth: ${view.name}`, target: ALLAUTH_USER_MODEL, entity: ALLAUTH_USER_MODEL, authUser: true, access: view.access,
          line: r.line, handler: routeSymbolName(r), calls: [],
        });
      }
    }
  },
};

const WRITE_ACTIONS = new Set(["create", "update", "partial_update", "destroy"]);
/** A generic API view's methods that write, by the verb the route carries. */
const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const VERB_ACTION: Record<string, string> = { POST: "create", PUT: "update", PATCH: "partial_update", DELETE: "destroy" };
/** The hook each write action calls to do its work. */
const PERFORM: Record<string, string> = { create: "perform_create", update: "perform_update", destroy: "perform_destroy" };
const MODEL_SERIALIZER = /^(?:ModelSerializer|HyperlinkedModelSerializer)$/;
const SUPER_CALL = /^super\s*\([^)]*\)\s*\.\s*(\w+)$/;

/** Whether the library's code for `name` runs for this class chain: no project method, or one handing on with `super()`. */
function libraryRuns(chain: readonly ClassAt[], name: string): boolean {
  let from = 0;
  for (let depth = 0; depth < 8; depth++) {
    const decl = declaredAlong(chain, name, from);
    if (!decl) return true;
    if (!decl.fn.calls.some((c) => SUPER_CALL.exec(c.name)?.[1] === name)) return false;
    from = decl.at + 1;
  }
  return false;
}

const addRow = (a: FileAnalysis, row: DataSourceInfo): void => {
  if (a.dataSources.some((d) => d.kind === "database" && d.line === row.line && d.name === row.name && d.handler === row.handler && d.entity === row.entity)) return;
  a.dataSources.push(row);
};

export const drfLibraryWrites: RouteResolver = {
  id: "drf-library-writes",
  languages: ["python"],
  priority: 31,
  resolve(analyses: FileAnalysis[], _ctx: ProjectContext): void {
    const candidates = analyses.filter((a) => (a.routeFacts ?? []).length > 0 || a.routes.some((r) => r.owner || r.handler) || a.classes.length > 0);
    if (candidates.length === 0) return;
    const index = new PythonClassIndex(analyses);
    /** The model a view's `queryset` names, else its `get_queryset`'s, else its serializer's `Meta.model`. */
    const modelOf = (chain: readonly ClassAt[]): string | null => {
      for (const c of chain) {
        const row = c.file.dataSources.find((d) => d.kind === "database" && d.entity && d.line > c.cls.line && d.line <= c.cls.endLine
          && !c.cls.methods.some((m) => d.line >= m.line && d.line <= m.endLine) && /(?:^|\.)objects\b/.test(d.name));
        if (row) return row.entity!;
      }
      // `get_queryset` returning `Club.objects.filter(…)`: the one model its body reads through a manager.
      const getter = declaredAlong(chain, "get_queryset");
      if (getter) {
        const file = chain[getter.at]!.file;
        const entities = new Set(file.dataSources.filter((d) => d.kind === "database" && d.entity && d.line >= getter.fn.line && d.line <= getter.fn.endLine && /(?:^|\.)objects\b/.test(d.name)).map((d) => d.entity!));
        if (entities.size === 1) return [...entities][0]!;
        return null;
      }
      const serializer = index.viewSerializer(chain);
      return serializer ? index.metaModelOf(index.chainOf(serializer).chain)?.model ?? null : null;
    };

    // ── A route whose write is the library's ──
    for (const a of analyses) {
      for (const r of a.routes) {
        if (r.kind !== "api" || !r.httpMethod || !r.handler) continue;
        const method = r.httpMethod.toUpperCase();
        const dot = r.handler.indexOf(".");
        // A registered viewset's action (`owner` + `Class.action`), or a generic view named by its class.
        const action = dot >= 0 ? r.handler.slice(dot + 1) : VERB_ACTION[method] ?? null;
        const className = r.owner ?? (dot < 0 ? r.handler : null);
        if (!className || !action || !WRITE_ACTIONS.has(action) || (dot < 0 && !WRITE_VERBS.has(method))) continue;
        const cls = index.classNamed(className, a);
        if (!cls) continue;
        const { chain, external } = index.chainOf(cls);
        if (!external.some((b) => DRF_GENERIC_VIEW.test(b))) continue;
        // Every step down to the save is the library's (a project one handing on with `super()` still is).
        const steps = [...(dot < 0 ? [method.toLowerCase()] : []), action, ...(action === "partial_update" ? ["update"] : []), PERFORM[action === "partial_update" ? "update" : action]!];
        if (!steps.every((step) => libraryRuns(chain, step))) continue;
        const model = modelOf(chain);
        if (!model) continue;
        const entity = model.split(".").pop()!;
        addRow(a, {
          kind: "database", name: `${className}: ${action ?? method.toLowerCase()}`, target: entity, entity, access: "write",
          line: r.line, handler: `route:${r.httpMethod} ${r.path}`, calls: [],
        });
      }
    }

    // ── A `serializer.save()` that runs the library's create / update ──
    for (const site of serializerSites(candidates)) {
      if (site.run !== "save:create" && site.run !== "save:update") continue;
      const { chain, external } = index.chainOf(site.serializer);
      if (!external.some((b) => MODEL_SERIALIZER.test(b))) continue;
      const step = site.run === "save:create" ? "create" : "update";
      if (!libraryRuns(chain, "save") || !libraryRuns(chain, step)) continue;
      const model = index.metaModelOf(chain)?.model;
      if (!model) continue;
      const entity = model.split(".").pop()!;
      addRow(site.file, { kind: "database", name: `${site.callName} (${site.serializer.cls.name}.${step})`, target: entity, entity, access: "write", line: site.line, calls: [] });
    }
  },
};
