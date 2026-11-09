import type { CallInfo, FileAnalysis, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { enclosingModules } from "./index.js";
import { railsUnderscore } from "./schema.js";
import { guardForFilter } from "./route-meta.js";
import { withInheritedGuards } from "../../shared/route-metadata.js";
import { singularize } from "../shared/inflection.js";

const HANDLER_RE = /^((?:[A-Z]\w*::)*[A-Z]\w*Controller)#(\w+)$/;

/**
 * Rails routes, anchored on the action that serves them.
 *
 * `config/routes.rb` declares a route; the controller action is the code a
 * request runs. Every other framework's route sits on its handler (a Spring or
 * ASP.NET action, a Django view), and that is where a caller's link should land:
 * a `resources :labels` row anchored on line 362 of the router said nothing
 * about which method answers `GET /labels/:id`. A row whose `Controller#action`
 * the project defines — on the controller or the first ancestor that has it —
 * moves to that method's file and line. One whose action nobody writes (an
 * implicit render, a gem's controller) stays where it was declared. The
 * plugin's convention rows — paths guessed from a controller's action names —
 * give way for every action the router declares.
 */
export const railsRouteAnchor: RouteResolver = {
  id: "rails-route-anchor",
  // ERB files only as the templates an action without a method renders.
  languages: ["ruby", "erb"],
  priority: 50,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const byName = new Map<string, ClassRef | null>();
    const qualified = new Map<ClassRef, string>();
    // Modules a controller includes (`include LabelConcern`) may define its actions.
    const modules = new Map<string, ClassRef | null>();
    for (const a of analyses) {
      for (const ref of ctx.classes.classesIn(a.filePath)) {
        if (ref.cls.name.endsWith("Controller")) continue;
        const name = [...enclosingModules(ref.cls, a.classes), ref.cls.name.split("::").pop()!].join("::");
        modules.set(name, modules.has(name) ? null : ref);
      }
    }
    for (const a of analyses) {
      for (const ref of ctx.classes.classesIn(a.filePath)) {
        if (!ref.cls.name.endsWith("Controller")) continue;
        // `module Staff; class UsersController` is `Staff::UsersController`.
        const leaf = ref.cls.name.split("::").pop()!;
        const name = [...enclosingModules(ref.cls, a.classes), leaf].join("::");
        // Two files declaring one controller (an engine override) — refuse to choose.
        byName.set(name, byName.has(name) ? null : ref);
        qualified.set(ref, name);
      }
    }
    if (byName.size === 0) return;

    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    // A row in its controller's own file is the plugin's guess from the action
    // name (`def show` → `GET /mfa/:id`); one in a router file is declared.
    const isGuess = (a: FileAnalysis, r: RouteInfo): boolean => {
      const m = r.handler ? HANDLER_RE.exec(r.handler) : null;
      return !!m && byName.get(m[1]!)?.filePath === a.filePath;
    };
    // Rails serves an action only at the paths the router gives it: a guessed
    // row for an action the router declares is a second, often wrong, path.
    const declared = new Set<string>();
    for (const a of analyses) for (const r of a.routes) if (r.handler && HANDLER_RE.test(r.handler) && !isGuess(a, r)) declared.add(r.handler);
    // Where a sub-project has a router, a controller is served only where it
    // says: a guess for an action it never names (a public helper), or for a
    // controller it never routes at all, is no endpoint — unless a legacy
    // `/:controller(/:action)` route serves any action, or the controller is
    // built on a gem's (Devise's), whose own routing DSL (`devise_for`) may
    // serve it. A gem-based controller the router names itself (an admin
    // framework's `resources :clubs`) and hands to no gem DSL is served only
    // where it says too.
    const routedProjects = new Set<string | undefined>();
    const named = new Set<string>();
    for (const a of analyses) {
      for (const r of a.routes) {
        const m = r.handler && !isGuess(a, r) ? HANDLER_RE.exec(r.handler) : null;
        if (!m) continue;
        routedProjects.add(a.projectId);
        named.add(m[1]!);
      }
    }
    const gemRouted = new Set<string>();
    for (const a of analyses) for (const f of a.routeFacts ?? []) if (f.kind === "rails-gem-controllers") for (const c of f.data as string[]) gemRouted.add(c);
    const catchAll = analyses.some((a) => a.routes.some((r) => !isGuess(a, r) && /:action\b/.test(r.path)));
    const guessDropped = (handler: string): boolean => {
      const controller = handler.split("#")[0]!;
      const ref = byName.get(controller);
      if (catchAll || !ref || !routedProjects.has(byPath.get(ref.filePath)?.projectId)) return false;
      if (/^(?:::)?ActionController::(?:Base|API)$/.test(chainEnd(ref, byName, qualified).cls.extends ?? "")) return true;
      // A gem DSL inside a `namespace` may name the controller relative to it: match by suffix.
      return named.has(controller) && ![...gemRouted].some((c) => c === controller || controller.endsWith(`::${c}`));
    };

    // What a guess knew that the router row does not: the controller's filters
    // (auth, middleware) and the parameters its body reads.
    const guessOf = new Map<string, RouteInfo>();
    for (const a of analyses) for (const r of a.routes) if (isGuess(a, r) && declared.has(r.handler!)) guessOf.set(r.handler!, r);

    // Templates an action without a method still renders (`app/views/clubs/new.html.erb`),
    // and the view directories that have any.
    const views = new Set<string>();
    for (const a of analyses) {
      const v = /(?:^|\/)app\/views\/(.+?)\/([^/.]+)\.[^/]*$/.exec(a.filePath);
      if (v) views.add(`${v[1]}/${v[2]}`).add(`${v[1]}/`);
    }
    // Every class or module by its last segment: an extension module named for
    // the controller under a namespace (`Premium::Api::ClubsController`, prepended
    // at boot) may define its actions.
    const byLeaf = new Map<string, ClassRef[]>();
    for (const a of analyses) {
      for (const ref of ctx.classes.classesIn(a.filePath)) {
        const leaf = ref.cls.name.split("::").pop()!;
        byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), ref]);
      }
    }

    // Association name → the one model it points at, for typing what a reader returns.
    const assoc = new Map<string, Set<string>>();
    for (const a of analyses) for (const rel of a.entityRelations ?? []) (assoc.get(rel.fromField) ?? assoc.set(rel.fromField, new Set()).get(rel.fromField)!).add(rel.toEntity.split("::").pop()!);

    const moved = new Map<FileAnalysis, RouteInfo[]>();
    for (const a of analyses) {
      if (a.routes.length === 0) continue;
      const kept: RouteInfo[] = [];
      for (const r of a.routes) {
        if (isGuess(a, r)) {
          if (!declared.has(r.handler!) && !guessDropped(r.handler!)) kept.push(r);
          continue;
        }
        const m = r.handler ? HANDLER_RE.exec(r.handler) : null;
        const ref = m ? byName.get(m[1]!) : null;
        const action = ref ? definerOf(ref, m![2]!, byName, qualified, modules) : null;
        // `resources :clubs` declares `new`/`edit`/… for every action; one the
        // controller never defines, inherits nowhere and has no view for is a 404.
        if (ref && !action && servesNothing(ref, m![2]!, byName, qualified, views, byLeaf)) continue;
        const target = action ? byPath.get(action.file) : undefined;
        if (!action || !target || action.file === a.filePath) {
          kept.push(r);
          continue;
        }
        const list = moved.get(target) ?? [];
        const row = withController(r, action.fn, guessOf.get(r.handler!));
        // An action runs its `before_action` filters first: what they load
        // (`@match ||= Current.league.matches.find_by!(…)`) is the
        // action's data too.
        const filters = filterCalls(ref!, m![2]!, byName, qualified, modules, row.line);
        if (filters.length > 0) {
          row.calls = [...row.calls, ...filters];
          if (action.file === ref!.filePath && !action.fn.calls.some((c) => filters.some((f) => f.name === c.name))) action.fn.calls.push(...filters);
        }
        // An action a module (a concern) defines calls, by bare name, methods the controller
        // including it supplies (`valid_token?`, `model`): THIS controller's own, not the
        // concern's placeholder of that name, is what this route runs.
        row.calls = templateHookCalls(row.calls, action, ref!, byName, qualified, modules, assoc);
        list.push(row);
        moved.set(target, list);
      }
      if (kept.length !== a.routes.length) a.routes = kept;
    }
    for (const [a, rows] of moved) a.routes = [...a.routes, ...rows];

    inheritedGemActions(analyses, byName, qualified, byLeaf);
    deviseModelActions(analyses, byName, qualified, modules);

    // An ancestor's guard filter (`before_action :authenticate_user!` on an
    // `Api::BaseController`) runs before every action of each subclass, unless
    // one skips it: per file only the controller's own filters were applied.
    for (const a of analyses) {
      let changed = false;
      const next = a.routes.map((r) => {
        const m = r.kind === "api" && r.handler ? HANDLER_RE.exec(r.handler) : null;
        const ref = m ? byName.get(m[1]!) : null;
        if (!ref) return r;
        const guards = chainFilters(ref, m![2]!, byName, qualified).flatMap((name) => guardForFilter(name, `before_action :${name}`) ?? []);
        if (guards.every((g) => r.middleware.includes(g.text))) return r;
        changed = true;
        return withInheritedGuards(r, guards);
      });
      if (changed) a.routes = next;
    }
  },
};

/**
 * Controllers built on a gem whose base class supplies the CRUD actions and
 * names the model after the controller (an admin framework: `Clubs` →
 * `Club`). The base is a stated fact of the class (`extends`), the actions
 * and what each does to the model are the gem's documented convention.
 */
const INHERITED_CRUD_BASES: ReadonlyArray<{ base: RegExp; actions: Readonly<Record<string, "read" | "write" | null>>; overrides: readonly string[] }> = [
  {
    base: /^(?:::)?Administrate::ApplicationController$/,
    actions: { index: "read", show: "read", new: null, edit: "read", create: "write", update: "write", destroy: "write" },
    // A project that states the model itself no longer gets it from the name (`scoped_resource`
    // and `find_resource` narrow which records, never which model).
    overrides: ["resource_class", "resource_name"],
  },
];

/**
 * A route the router declares for an action nobody in the tree writes, on a
 * controller whose gem base supplies it, reaches the model the controller's
 * name implies: the row stays on the router and carries the model's access as
 * its own (`DataSourceInfo.handler`). The model must be a class of the project;
 * an unknown one is never invented.
 */
function inheritedGemActions(
  analyses: FileAnalysis[],
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  byLeaf: ReadonlyMap<string, ClassRef[]>,
): void {
  for (const a of analyses) {
    for (const r of a.routes) {
      const m = r.handler ? HANDLER_RE.exec(r.handler) : null;
      const ref = m ? byName.get(m[1]!) : null;
      if (!ref) continue;
      const defined = definerOf(ref, m![2]!, byName, qualified, new Map());
      if (defined) {
        // An override that calls `super` also runs what the gem's action does to the model —
        // unless a project class above it defines the action (then that one is what `super` reaches).
        if (!defined.fn.calls.some((c) => c.name === "super")) continue;
        const up = superOf(defined.owner, byName, qualified);
        if (up && definerOf(up, m![2]!, byName, qualified, new Map())) continue;
      } else if (ref.filePath === a.filePath) continue;
      const end = chainEnd(ref, byName, qualified);
      const rule = INHERITED_CRUD_BASES.find((b) => b.base.test(end.cls.extends ?? ""));
      const access = rule?.actions[m![2]!];
      if (!rule || !access) continue;
      const chain = chainOf(ref, byName, qualified);
      if (chain.some((c) => c.cls.methods.some((f) => rule.overrides.includes(f.name)))) continue;
      const leaf = (qualified.get(ref) ?? ref.cls.name).split("::").pop()!.replace(/Controller$/, "");
      const words = leaf.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [leaf];
      const model = [...words.slice(0, -1), singularize(words[words.length - 1]!)].join("");
      // The gem resolves the model as a top-level constant (`Club`), whatever namespace the controller sits in.
      const hits = (byLeaf.get(model) ?? []).filter((c) => c.cls.name === model);
      if (hits.length !== 1) continue;
      const handler = `route:${r.httpMethod ?? "USE"} ${r.path}`;
      const verb = access === "write" ? m![2]! : m![2] === "index" ? "all" : "find";
      if (a.dataSources.some((d) => d.handler === handler && d.entity === model)) continue;
      a.dataSources.push({ kind: "database", name: `${model}.${verb}`, target: null, calls: [], line: r.line, entity: model, access, handler });
    }
  }
}

/**
 * A route a devise_token_auth mount or a `devise_for` draws (`rails-devise-model` fact: the
 * model the mount names, the access the gem's action has on it) carries that access as its own — when the
 * controller serving it is the gem's, or a project class whose action calls `super` into
 * the gem. An action the project writes without `super` is its own code, read as written.
 * The model must be one class of the project, by exact name.
 */
function deviseModelActions(
  analyses: FileAnalysis[],
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  modules: Map<string, ClassRef | null>,
): void {
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind !== "rails-devise-model") continue;
      const d = f.data as { model: string; method: string; path: string; handler: string; action: string; access: "read" | "write"; gem?: string };
      // `modules` holds every non-controller class by qualified name, a name two files declare as null.
      if (!modules.get(d.model)) continue;
      const model = d.model.split("::").pop()!;
      const m = HANDLER_RE.exec(d.handler);
      const ref = m ? byName.get(m[1]!) : null;
      if (ref) {
        const defined = definerOf(ref, d.action, byName, qualified, modules);
        if (defined && !defined.fn.calls.some((c) => c.name === "super")) continue;
        // Under a project override the chain must end in the gem, not in another base.
        // `gem`: the module whose controllers the fact's access describes (devise_token_auth's by default).
        if (!new RegExp(String.raw`^(?:::)?${d.gem ?? "DeviseTokenAuth"}::\w+Controller$`).test(chainEnd(ref, byName, qualified).cls.extends ?? "")) continue;
      }
      for (const b of analyses) {
        const row = b.routes.find((r) => r.httpMethod === d.method && r.path === d.path && r.handler === d.handler);
        if (!row) continue;
        const handler = `route:${d.method} ${d.path}`;
        if (b.dataSources.some((s) => s.handler === handler && s.entity === model)) break;
        const verb = d.access === "write" ? d.action : d.action === "edit" ? "find" : "find_for_authentication";
        b.dataSources.push({ kind: "database", name: `${model}.${verb}`, target: null, calls: [], line: row.line, entity: model, access: d.access, handler });
        break;
      }
    }
  }
}

/**
 * The calls of a concern's action, each bare-named one the controller (or an
 * ancestor, or another module) supplies in place of the concern's own
 * placeholder pointed at that definition. The concern keeps its own links
 * (it serves every includer); only this route's row is specific.
 */
function templateHookCalls(
  calls: CallInfo[],
  action: { fn: FunctionInfo; owner: ClassRef },
  ref: ClassRef,
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  modules: Map<string, ClassRef | null>,
  assoc: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): CallInfo[] {
  if (action.owner === ref || chainOf(ref, byName, qualified).includes(action.owner)) return calls;
  let changed = false;
  const out = calls.map((c) => {
    // `model.update_badges` where the controller's own `def model; @model ||= @match; end`
    // is typed by where `@match` is assigned: the call is the model's.
    const reader = c.kind === "internal" ? /^([a-z_]\w*)\.([a-z_]\w*[?!]?)$/.exec(c.name) : null;
    if (reader) {
      const hook = definerOf(ref, reader[1]!, byName, qualified, modules);
      const type = hook && hook.owner !== action.owner ? readerType(chainOf(ref, byName, qualified), reader[1]!, assoc, modules, 0) : null;
      // The member is found on the model or a module it includes: that class's own name is the callee.
      const model = type ? modules.get(type) : null;
      const member = model ? definerOf(model, reader[2]!, byName, qualified, modules) : null;
      if (member) {
        changed = true;
        return { ...c, name: `${member.owner.cls.name}.${reader[2]}`, target: null };
      }
      return c;
    }
    if (c.kind !== "internal" || !/^[a-z_]\w*[?!]?$/.test(c.name) || c.name === action.fn.name) return c;
    const hook = definerOf(ref, c.name, byName, qualified, modules);
    if (!hook || hook.owner === action.owner || hook.fn === action.fn) return c;
    changed = true;
    return { ...c, name: `${hook.owner.cls.name}.${c.name}`, target: null };
  });
  return changed ? out : calls;
}

/**
 * The model a memoizing reader (`def model; @model ||= @match; end`) returns: the type
 * its instance variable is assigned where the project states one — a model constant
 * (`@match = Match.find(…)`) or an association with one target (`Current.league.matches.find_by!(…)`),
 * through other variables (`@model ||= @match`), in the controller or an ancestor. Several
 * assignments must agree; anything else is no type.
 */
function readerType(
  chain: ClassRef[],
  ivar: string,
  assoc: ReadonlyMap<string, ReadonlySet<string>>,
  modules: Map<string, ClassRef | null>,
  depth: number,
): string | null {
  if (depth > 4) return null;
  const owner = chain.find((c) => c.cls.fieldValues?.[ivar] !== undefined);
  if (!owner) return null;
  const found = new Set<string>();
  for (const rhs of owner.cls.fieldValues![ivar]!.split("\n")) {
    const alias = /^@([a-z_]\w*)$/.exec(rhs)?.[1];
    if (alias) {
      const t = alias === ivar ? null : readerType(chain, alias, assoc, modules, depth + 1);
      if (t) found.add(t);
      continue;
    }
    const segs = rhs.replace(/\([^()]*\)/g, "").replace(/\([^()]*\)/g, "").split(".");
    let type: string | null = null;
    for (let k = segs.length - 2; k >= 1 && !type; k--) {
      const targets = assoc.get(segs[k]!);
      if (targets?.size === 1) type = [...targets][0]!;
    }
    const head = segs[0]!.replace(/^::/, "");
    if (!type && segs.length >= 2 && /^[A-Z]/.test(head) && modules.get(head)) type = head.split("::").pop()!;
    if (type) found.add(type);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * The declared row on its action: the action's calls (what the request runs),
 * and the controller's filters and parameter reads from the guessed row of the
 * same action, merged with the router's own guards (Devise `authenticate`).
 */
function withController(r: RouteInfo, fn: FunctionInfo, guess: RouteInfo | undefined): RouteInfo {
  const row: RouteInfo = { ...r, line: fn.line, calls: fn.calls };
  if (!guess) return row;
  row.middleware = [...new Set([...r.middleware, ...guess.middleware])];
  if (guess.params) row.params = guess.params;
  if (r.auth && guess.auth) {
    row.auth = {
      policies: [...new Set([...r.auth.policies, ...guess.auth.policies])],
      roles: [...new Set([...r.auth.roles, ...guess.auth.roles])],
      schemes: [...new Set([...r.auth.schemes, ...guess.auth.schemes])],
      anonymous: guess.auth.anonymous,
      inherited: r.auth.inherited && guess.auth.inherited,
    };
  } else if (guess.auth) {
    row.auth = guess.auth;
  }
  return row;
}

/**
 * The `def action` a request to `ref#action` runs: on the class, else the first
 * superclass declaring it. A superclass is found by name the way Ruby looks a
 * constant up — `BaseController` written inside `Api::V1::Accounts::X` is tried
 * as `Api::V1::Accounts::BaseController`, then `Api::V1::BaseController`, … —
 * since Ruby states no import the class index could follow.
 */
function definerOf(
  ref: ClassRef,
  action: string,
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  modules: Map<string, ClassRef | null>,
): { file: string; fn: FunctionInfo; owner: ClassRef } | null {
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    const fn = c.cls.methods.find((f) => f.name === action);
    if (fn) return { file: c.filePath, fn, owner: c };
    // Ruby looks in the included modules next, the last included first.
    const scope = (qualified.get(c) ?? c.cls.name).split("::").slice(0, -1);
    for (const written of [...(c.cls.implements ?? [])].reverse()) {
      const mod = lookup(written, scope, modules);
      const mfn = mod?.cls.methods.find((f) => f.name === action);
      if (mfn) return { file: mod!.filePath, fn: mfn, owner: mod! };
    }
  }
  return null;
}

/**
 * Whether `ref#action` cannot be served: the class chain is the project's own
 * up to Rails' `ActionController::Base`/`API` (a gem base such as an admin
 * framework's supplies actions the project never writes), none of it handles a
 * missing action, no module named like the controller defines it, and no
 * template renders it implicitly. A `Base` controller renders HTML through
 * templates the analysis may not read (Haml, Slim): it is judged only when its
 * view directory holds templates the analysis does read.
 */
function servesNothing(
  ref: ClassRef,
  action: string,
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  views: ReadonlySet<string>,
  byLeaf: ReadonlyMap<string, ClassRef[]>,
): boolean {
  const name = qualified.get(ref) ?? ref.cls.name;
  const dir = name.split("::").map(railsUnderscore).join("/").replace(/_controller$/, "");
  if (views.has(`${dir}/${action}`)) return false;
  if ((byLeaf.get(name.split("::").pop()!) ?? []).some((c) => c !== ref && c.cls.name.endsWith(`::${name}`) && c.cls.methods.some((f) => f.name === action))) return false;
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    if (c.cls.methods.some((f) => f.name === "action_missing" || f.name === "method_missing")) return false;
  }
  const base = /^(?:::)?ActionController::(API|Base)$/.exec(chainEnd(ref, byName, qualified).cls.extends ?? "")?.[1];
  return base === "API" || (base === "Base" && views.has(`${dir}/`));
}

/** The last class of `ref`'s chain the project declares: its `extends` names the framework or gem base. */
function chainEnd(ref: ClassRef, byName: Map<string, ClassRef | null>, qualified: Map<ClassRef, string>): ClassRef {
  let last = ref;
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    last = c;
  }
  return last;
}

/** A constant as Ruby finds it from inside `scope`: innermost namespace first. */
function lookup<T>(written: string, scope: string[], table: Map<string, T | null>): T | null {
  const name = written.replace(/^::/, "");
  for (let k = scope.length; k >= 0; k--) {
    const hit = table.get([...scope.slice(0, k), name].join("::"));
    if (hit) return hit;
  }
  return null;
}

function superOf(ref: ClassRef, byName: Map<string, ClassRef | null>, qualified: Map<ClassRef, string>): ClassRef | null {
  const written = ref.cls.extends?.replace(/^::/, "");
  if (!written) return null;
  return lookup(written, (qualified.get(ref) ?? ref.cls.name).split("::").slice(0, -1), byName);
}

/** The class chain of `ref`, the root ancestor first. */
function chainOf(ref: ClassRef, byName: Map<string, ClassRef | null>, qualified: Map<ClassRef, string>): ClassRef[] {
  const chain: ClassRef[] = [];
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    chain.unshift(c);
  }
  return chain;
}

/** The filter names an action runs, from `before_action` decorators down the chain (`skip_before_action` removes one). */
function activeFilters(chain: readonly ClassRef[], action: string): string[] {
  const active: string[] = [];
  for (const c of chain) {
    for (const d of c.cls.decorators ?? []) {
      const m = /^(skip_before_action|before_action) :(\w+[?!]?)(?: only: ([\w?!,]+))?(?: except: ([\w?!,]+))?$/.exec(d);
      if (!m) continue;
      const only = m[3] ? m[3].split(",") : null;
      const except = m[4] ? m[4].split(",") : [];
      if ((only && !only.includes(action)) || except.includes(action)) continue;
      if (m[1] === "skip_before_action") {
        const i = active.indexOf(m[2]!);
        if (i >= 0) active.splice(i, 1);
      } else if (!active.includes(m[2]!)) active.push(m[2]!);
    }
  }
  return active;
}

/** The filters an action of `ref` runs that an ANCESTOR declares — its own were applied per file. */
function chainFilters(ref: ClassRef, action: string, byName: Map<string, ClassRef | null>, qualified: Map<ClassRef, string>): string[] {
  const chain = chainOf(ref, byName, qualified);
  if (chain.length < 2) return [];
  const own = new Set(activeFilters([ref], action));
  return activeFilters(chain, action).filter((name) => !own.has(name));
}

/**
 * The filter methods an action of `ref` runs, from its `before_action`
 * decorators up the class chain (an ancestor's first; `skip_before_action`
 * removes one), each as a call on the class that defines it.
 */
function filterCalls(
  ref: ClassRef,
  action: string,
  byName: Map<string, ClassRef | null>,
  qualified: Map<ClassRef, string>,
  modules: Map<string, ClassRef | null>,
  line: number,
): CallInfo[] {
  const chain = chainOf(ref, byName, qualified);
  const out: CallInfo[] = [];
  for (const name of activeFilters(chain, action)) {
    const def = definerOf(ref, name, byName, qualified, modules);
    if (!def) continue;
    const owner = [ref, ...chain].find((c) => c.filePath === def.file && c.cls.methods.includes(def.fn))
      ?? [...modules.values()].find((c) => c?.filePath === def.file && c.cls.methods.includes(def.fn));
    if (!owner) continue;
    out.push({ name: `${owner.cls.name}.${name}`, kind: "internal", target: null, line });
  }
  return out;
}
