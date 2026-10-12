import type { FileAnalysis, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { enclosingModules } from "./index.js";

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
  languages: ["ruby"],
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
        const target = action ? byPath.get(action.file) : undefined;
        if (!action || !target || action.file === a.filePath) {
          kept.push(r);
          continue;
        }
        const list = moved.get(target) ?? [];
        list.push(withController(r, action.fn, guessOf.get(r.handler!)));
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
