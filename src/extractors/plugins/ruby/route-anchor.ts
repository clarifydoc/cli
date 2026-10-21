import type { CallInfo, FileAnalysis, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { enclosingModules } from "./index.js";
import { railsUnderscore } from "./schema.js";

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

    const moved = new Map<FileAnalysis, RouteInfo[]>();
    for (const a of analyses) {
      if (a.routes.length === 0) continue;
      const kept: RouteInfo[] = [];
      for (const r of a.routes) {
        if (isGuess(a, r)) {
          if (!declared.has(r.handler!)) kept.push(r);
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
        // (`@conversation ||= Current.account.conversations.find_by!(…)`) is the
        // action's data too.
        const filters = filterCalls(ref!, m![2]!, byName, qualified, modules, row.line);
        if (filters.length > 0) {
          row.calls = [...row.calls, ...filters];
          if (action.file === ref!.filePath && !action.fn.calls.some((c) => filters.some((f) => f.name === c.name))) action.fn.calls.push(...filters);
        }
        list.push(row);
        moved.set(target, list);
      }
      if (kept.length !== a.routes.length) a.routes = kept;
    }
    for (const [a, rows] of moved) a.routes = [...a.routes, ...rows];
  },
};

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
): { file: string; fn: FunctionInfo } | null {
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    const fn = c.cls.methods.find((f) => f.name === action);
    if (fn) return { file: c.filePath, fn };
    // Ruby looks in the included modules next, the last included first.
    const scope = (qualified.get(c) ?? c.cls.name).split("::").slice(0, -1);
    for (const written of [...(c.cls.implements ?? [])].reverse()) {
      const mod = lookup(written, scope, modules);
      const mfn = mod?.cls.methods.find((f) => f.name === action);
      if (mfn) return { file: mod!.filePath, fn: mfn };
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
  let last = ref;
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    if (c.cls.methods.some((f) => f.name === "action_missing" || f.name === "method_missing")) return false;
    last = c;
  }
  const base = /^(?:::)?ActionController::(API|Base)$/.exec(last.cls.extends ?? "")?.[1];
  return base === "API" || (base === "Base" && views.has(`${dir}/`));
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
  const chain: ClassRef[] = [];
  const seen = new Set<ClassRef>();
  for (let c: ClassRef | null | undefined = ref; c && !seen.has(c); c = superOf(c, byName, qualified)) {
    seen.add(c);
    chain.unshift(c);
  }
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
  const out: CallInfo[] = [];
  for (const name of active) {
    const def = definerOf(ref, name, byName, qualified, modules);
    if (!def) continue;
    const owner = [ref, ...chain].find((c) => c.filePath === def.file && c.cls.methods.includes(def.fn))
      ?? [...modules.values()].find((c) => c?.filePath === def.file && c.cls.methods.includes(def.fn));
    if (!owner) continue;
    out.push({ name: `${owner.cls.name}.${name}`, kind: "internal", target: null, line });
  }
  return out;
}
