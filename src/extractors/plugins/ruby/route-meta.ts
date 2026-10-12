import type { ClassInfo, FunctionInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta, pathParamNames } from "../../shared/route-metadata.js";

/**
 * The attribute layer of Ruby routes — what a Rails/Sinatra handler reads from
 * the request and which filters guard it. Rails declares neither in a
 * signature: an action is `def create` and the bindings live in the body
 * (`params.require(:user).permit(:name)`), the guards in class-level
 * `before_action` macros. Everything here is per file, line-based, and feeds
 * the same `RouteInfo.params` / `auth` / `middleware` every other framework
 * fills.
 */

// ─── Request access (what an action body reads) ──────────────────────────────

/** Rails member/nested-resource convention: `id` and `*_id` come from the path. */
const ROUTE_KEY_RE = /^(?:id|\w+_id)$/;

/** Strip a trailing `# comment` (quote-aware enough for the patterns we read). */
function stripComment(line: string): string {
  const idx = line.search(/(?<!['"\w])#(?!\{)/);
  return idx >= 0 ? line.slice(0, idx) : line;
}

/** `:name, :email, roles: []` → name, email, roles. */
function permitKeys(args: string): string[] {
  const keys: string[] = [];
  for (const m of args.matchAll(/:(\w+)/g)) keys.push(m[1]!);
  for (const m of args.matchAll(/\b(\w+):\s*[\[{]/g)) if (!keys.includes(m[1]!)) keys.push(m[1]!);
  return keys;
}

/**
 * What a Ruby method body reads from the request. Recognised shapes:
 * `params.require(:user).permit(:a, :b)` → body `user` + `user.a`, `user.b`;
 * `params.permit(:a)` → body `a`; `params[:id]` / `params.fetch(:q)` → route
 * for `id`/`*_id` (the Rails member convention), query otherwise;
 * `request.headers["X"]` → header; `request.body.read` / `request.raw_post`
 * → body. Returns nothing for a body that never touches `params`/`request`.
 */
export function extractRubyRequestAccess(bodyLines: string[]): RouteParamInfo[] {
  const text = bodyLines.map(stripComment).join("\n");
  if (!/\bparams\b|\brequest\b/.test(text)) return [];
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, binding: RouteParamBinding): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding });
  };

  // params.require(:user).permit(:name, :email, roles: [])  — permit may wrap lines.
  for (const m of text.matchAll(/\bparams\s*\.\s*require\s*\(\s*:(\w+)\s*\)(?:\s*\.\s*permit\s*\(([^)]*)\))?/g)) {
    add(m[1]!, "body");
    for (const key of permitKeys(m[2] ?? "")) add(`${m[1]}.${key}`, "body");
  }
  for (const m of text.matchAll(/\bparams\s*\.\s*permit\s*\(([^)]*)\)/g)) {
    for (const key of permitKeys(m[1]!)) add(key, "body");
  }
  // params[:id] / params["q"] / params.fetch(:x) / params.dig(:x)
  for (const m of text.matchAll(/\bparams\s*(?:\[\s*:?['"]?(\w+)['"]?\s*\]|\.\s*(?:fetch|dig)\s*\(\s*:?['"]?(\w+)['"]?)/g)) {
    const name = (m[1] ?? m[2])!;
    add(name, ROUTE_KEY_RE.test(name) ? "route" : "query");
  }
  for (const m of text.matchAll(/\brequest\s*\.\s*query_parameters\s*\[\s*:?['"]?(\w+)['"]?\s*\]/g)) add(m[1]!, "query");
  for (const m of text.matchAll(/\brequest\s*\.\s*request_parameters\s*\[\s*:?['"]?(\w+)['"]?\s*\]/g)) add(m[1]!, "body");
  for (const m of text.matchAll(/\brequest\s*\.\s*headers\s*(?:\[\s*['"]([^'"]+)['"]\s*\]|\.\s*(?:fetch|\[)\s*\(?\s*['"]([^'"]+)['"])/g)) {
    add((m[1] ?? m[2])!, "header");
  }
  if (/\brequest\s*\.\s*(?:body\s*\.\s*read|raw_post)\b/.test(text)) add("body", "body");
  return out;
}

/**
 * Rails strong parameters conventionally live in a private `user_params`
 * method the action calls, so the access sits on the helper, not the action.
 * Copy each helper's access onto every sibling method whose body names it —
 * one hop, same class — so both the convention route and the `routes.rb`
 * handler join see it on the action.
 */
export function propagateHelperAccess(lines: string[], classes: ClassInfo[]): void {
  for (const cls of classes) {
    const helpers = cls.methods.filter((m) => (m.requestAccess?.length ?? 0) > 0);
    if (helpers.length === 0) continue;
    for (const method of cls.methods) {
      const body = lines.slice(method.line, Math.max(method.line, method.endLine)).join("\n");
      for (const helper of helpers) {
        if (helper === method) continue;
        if (!new RegExp(`(?<![\\w.:@])${helper.name}(?![\\w?!])`).test(body)) continue;
        const merged = [...(method.requestAccess ?? [])];
        const seen = new Set(merged.map((p) => `${p.binding}:${p.name}`));
        for (const acc of helper.requestAccess!) {
          const key = `${acc.binding}:${acc.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push({ ...acc });
        }
        method.requestAccess = merged;
      }
    }
  }
}

/** Route-level params from what the body reads, re-bound by the path template. */
function paramsFromAccess(access: readonly RouteParamInfo[] | undefined, path: string): RouteParamInfo[] {
  if (!access || access.length === 0) return [];
  const tokens = pathParamNames(path);
  return access.map((p) => ({
    ...p,
    binding: tokens.has(p.name.toLowerCase()) ? "route" : p.binding,
    inferred: true,
  }));
}

// ─── Guards ──────────────────────────────────────────────────────────────────

/** A `before_action` name that reads as an access check rather than a loader. */
const AUTH_FILTER_RE =
  /auth|login|logged|signed_in|session|require|ensure|verify|permission|permit|admin|token|access|role|guard|owner|current_user|user_exists|check_|can_|allowed/i;

/** Devise's generated helpers: `authenticate_user!`, `authenticate_admin_user!`. */
const DEVISE_RE = /^authenticate_\w+!$/;

const ANY_ACTION = null;

export interface FilterDecl {
  /** Filter method names on this macro line. */
  names: string[];
  /** As written, minus the `only:`/`except:` scoping. */
  text: string;
  only: Set<string> | null;
  except: Set<string>;
  kind: "filter" | "skip" | "macro";
  guard: GuardAttr | null;
}

/** `only: [:a, :b]` / `except: :a` / `:only => [...]` on a macro line. */
function actionScope(stmt: string): { only: Set<string> | null; except: Set<string> } {
  let only: Set<string> | null = ANY_ACTION;
  const except = new Set<string>();
  const onlyM = stmt.match(/(?:\bonly\s*:|:only\s*=>)\s*(\[[^\]]*\]|:\w+|%[wi]\[[^\]]*\])/);
  if (onlyM) only = new Set([...onlyM[1]!.matchAll(/[:\s\[](\w+)/g)].map((m) => m[1]!));
  const exceptM = stmt.match(/(?:\bexcept\s*:|:except\s*=>)\s*(\[[^\]]*\]|:\w+|%[wi]\[[^\]]*\])/);
  if (exceptM) for (const m of exceptM[1]!.matchAll(/[:\s\[](\w+)/g)) except.add(m[1]!);
  return { only, except };
}

function appliesTo(decl: { only: Set<string> | null; except: Set<string> }, action: string): boolean {
  if (decl.only && !decl.only.has(action)) return false;
  return !decl.except.has(action);
}

function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** The guard a filter method name implies, or null for a plain loader (`set_user`). */
function guardForFilter(name: string, text: string): GuardAttr | null {
  if (DEVISE_RE.test(name)) return { text, policies: [name], schemes: ["devise"] };
  if (!AUTH_FILTER_RE.test(name)) return null;
  return { text, policies: [name] };
}

/**
 * Class-level filter macros in a controller body: `before_action`,
 * `skip_before_action`, `http_basic_authenticate_with`, CanCan's
 * `load_and_authorize_resource`, Pundit's `verify_authorized`. Lines inside a
 * method body are ignored — the macros sit at class level.
 */
export function collectFilters(lines: string[], cls: ClassInfo): FilterDecl[] {
  const inMethod = (idx: number): boolean => cls.methods.some((m) => idx + 1 >= m.line && idx + 1 < m.endLine);
  const decls: FilterDecl[] = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    if (inMethod(i)) continue;
    let stmt = stripComment(lines[i] ?? "").trim();
    if (!stmt) continue;
    // A macro whose argument list wraps: `before_action :x,\n  only: [...]`.
    let j = i;
    while (/,\s*$/.test(stmt) && j + 1 < lines.length && j - i < 4) stmt += " " + stripComment(lines[++j] ?? "").trim();

    const filter = stmt.match(/^(?:(prepend|append)_)?before_(?:action|filter)\s+(.*)$/);
    if (filter) {
      const names = filterNames(filter[2]!);
      if (names.length === 0) continue;
      const { only, except } = actionScope(stmt);
      for (const name of names) {
        const text = `before_action :${name}`;
        decls.push({ names: [name], text, only, except, kind: "filter", guard: guardForFilter(name, text) });
      }
      continue;
    }
    const skip = stmt.match(/^skip_before_(?:action|filter)\s+(.*)$/);
    if (skip) {
      const names = filterNames(skip[1]!);
      const { only, except } = actionScope(stmt);
      for (const name of names) {
        const text = `skip_before_action :${name}`;
        // Skipping a loader waives nothing; skipping an auth filter opens the action.
        const guard = guardForFilter(name, text) ? { text, anonymous: true } : null;
        decls.push({ names: [name], text, only, except, kind: "skip", guard });
      }
      continue;
    }
    if (/^http_basic_authenticate_with\b/.test(stmt)) {
      const { only, except } = actionScope(stmt);
      decls.push({
        names: [],
        text: "http_basic_authenticate_with",
        only,
        except,
        kind: "macro",
        guard: { text: "http_basic_authenticate_with", schemes: ["basic"], policies: ["http_basic_authenticate_with"] },
      });
      continue;
    }
    const cancan = stmt.match(/^(load_and_authorize_resource|authorize_resource|check_authorization)\b/);
    if (cancan) {
      const { only, except } = actionScope(stmt);
      decls.push({ names: [], text: cancan[1]!, only, except, kind: "macro", guard: { text: cancan[1]!, policies: [cancan[1]!] } });
      continue;
    }
    const pundit = stmt.match(/^after_action\s+:(verify_authorized|verify_policy_scoped)\b/);
    if (pundit) {
      const { only, except } = actionScope(stmt);
      const text = `after_action :${pundit[1]}`;
      decls.push({ names: [pundit[1]!], text, only, except, kind: "macro", guard: { text, policies: ["pundit"] } });
      continue;
    }
    // `protect_from_forgery` is CSRF, not auth — deliberately not a guard.
  }
  return decls;
}

/** The filter symbols of a macro argument list, before any `only:`/`except:`/`if:` option. */
function filterNames(args: string): string[] {
  const head = args.split(/\b(?:only|except|if|unless|prepend)\s*:|:(?:only|except|if|unless)\s*=>/)[0]!;
  return [...head.matchAll(/(?:^|[\s,]):(\w+[?!]?)/g)].map((m) => m[1]!);
}

/**
 * Checks an action body performs itself: Pundit `authorize @record` /
 * `policy_scope(...)`, CanCan `authorize! :read, @x` / `can?(...)`, an inline
 * Devise `authenticate_user!`, Sinatra's `protected!` / `halt 401 unless …`.
 */
export function guardsInBody(bodyLines: string[]): GuardAttr[] {
  const guards: GuardAttr[] = [];
  const seen = new Set<string>();
  const push = (g: GuardAttr): void => {
    if (seen.has(g.text)) return;
    seen.add(g.text);
    guards.push(g);
  };
  for (const raw of bodyLines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/(?<![\w.:@])(authorize!?(?:\s+|\s*\()\s*[:@\w][\w:]*[^,)\n]*|policy_scope\s*\(?\s*[@\w:]+)/))) {
      const text = collapse(m[1]!);
      push({ text, policies: [text.startsWith("authorize!") ? "cancan" : "pundit"] });
    }
    if ((m = line.match(/(?<![\w.:@])can\?\s*\(?\s*:(\w+)/))) push({ text: collapse(m[0]!), policies: ["cancan"] });
    if ((m = line.match(/(?<![\w.:@])(authenticate_\w+!)/))) push({ text: m[1]!, policies: [m[1]!], schemes: ["devise"] });
    if ((m = line.match(/(?<![\w.:@])(protected!|authenticate!|require_login!?|require_admin!?|ensure_\w*(?:auth|login|admin|user|signed|logged)\w*!?)(?![\w?])/))) {
      push({ text: m[1]!, policies: [m[1]!] });
    }
    if ((m = line.match(/\bhalt\s*\(?\s*(401|403)\b[^\n]*/))) push({ text: collapse(m[0]!), policies: [collapse(m[0]!)] });
    if ((m = line.match(/\bredirect(?:_to)?\b[^\n]*\b(?:unless|if)\b[^\n]*\b(?:session|current_user|logged_in|signed_in|authenticated|user)\b[^\n]*/))) {
      push({ text: collapse(m[0]!), policies: [collapse(m[0]!)] });
    }
    if (/\bwarden\b.*\bauthenticate!?/.test(line)) push({ text: collapse(line), policies: ["warden.authenticate!"], schemes: ["warden"] });
  }
  return guards;
}

/**
 * Fill `params`, `middleware` and `auth` on a controller-convention route from
 * the class's filter macros and the action's own body. `before_action`
 * scoping (`only:`/`except:`) is honoured per action name; a
 * `skip_before_action` of an auth filter marks the action anonymous.
 */
export function applyControllerMeta(lines: string[], cls: ClassInfo, method: FunctionInfo, route: RouteInfo): void {
  const decls = collectFilters(lines, cls);
  const inherited: GuardAttr[] = [];
  const own: GuardAttr[] = [];
  const access: RouteParamInfo[] = [...(method.requestAccess ?? [])];
  const skipped = new Set<string>();
  for (const d of decls) {
    if (d.kind === "skip" && appliesTo(d, method.name)) for (const n of d.names) skipped.add(n);
  }
  for (const d of decls) {
    if (!appliesTo(d, method.name)) continue;
    if (d.kind === "skip") {
      if (d.guard) own.push(d.guard);
      continue;
    }
    if (d.names.some((n) => skipped.has(n))) continue;
    if (d.guard) inherited.push(d.guard);
    else {
      route.middleware.push(d.text);
      // A loader filter (`before_action :set_user`) reads the request on the
      // action's behalf — its `params[:id]` is the action's route param.
      for (const name of d.names) {
        const loader = cls.methods.find((m) => m.name === name);
        for (const acc of loader?.requestAccess ?? []) access.push(acc);
      }
    }
    // Rails runs the filter before the action: for the trace, the action calls
    // it. Recorded as a call of the method (the route shares its `calls`
    // array) so the linker binds `show` → `conversation`, where
    // `Current.account.conversations.find_by!(…)` actually runs — without it
    // every loader-pattern controller dead-ended at the action's own body.
    for (const name of d.names) {
      if (name === method.name || !cls.methods.some((m) => m.name === name)) continue;
      if (method.calls.some((c) => c.name === name)) continue;
      method.calls.push({ name, kind: "internal", target: null, line: method.line });
    }
  }
  own.push(...guardsInBody(lines.slice(method.line, Math.max(method.line, method.endLine))));
  const seen = new Set<string>();
  const merged = access.filter((p) => {
    const key = `${p.binding}:${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  applyRouteMeta(route, { inheritedGuards: inherited, guards: own, params: paramsFromAccess(merged, route.path) });
}

// ─── Sinatra ─────────────────────────────────────────────────────────────────

const SINATRA_VERB_RE = /^(\s*)(get|post|put|patch|delete|options|head)\s+(['"])([^'"]+)\3/;

/** True when the file is a Sinatra app: requires the gem or subclasses its base. */
export function isSinatraFile(lines: string[]): boolean {
  return lines.some((l) => /^\s*require\s+['"]sinatra(?:\/base)?['"]/.test(l) || /<\s*Sinatra::(?:Base|Application)\b/.test(l));
}

/** Index of the `end` closing a `do` block opened at `start` (same indent), or the file end. */
function blockEnd(lines: string[], start: number, indent: string): number {
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*)end\b/);
    if (m && m[1]!.length <= indent.length) return i;
  }
  return lines.length;
}

/**
 * Sinatra's block DSL: `get '/users/:id' do … end`. The block is the handler,
 * so there is nothing to join to — bindings come from the block body via the
 * same reader the Rails actions use, re-bound by the path's `:id` tokens.
 * `before do … end` blocks (optionally path-filtered) that check a session,
 * halt 401, or call `protected!` are inherited guards; `use Rack::Auth::Basic`
 * is a basic scheme.
 */
export function extractSinatraRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const inherited: Array<{ prefix: string; guard: GuardAttr }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*use\s+Rack::Auth::Basic\b/.test(line)) {
      inherited.push({ prefix: "", guard: { text: "Rack::Auth::Basic", schemes: ["basic"], policies: ["Rack::Auth::Basic"] } });
      continue;
    }
    const before = line.match(/^(\s*)before\b(?:\s+(['"])([^'"]+)\2)?\s*(?:do|\{)/);
    if (before) {
      const end = blockEnd(lines, i, before[1]!);
      const prefix = (before[3] ?? "").replace(/\*.*$/, "");
      for (const g of guardsInBody(lines.slice(i + 1, end))) inherited.push({ prefix, guard: g });
      continue;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(SINATRA_VERB_RE);
    if (!m || !/\b(?:do|\{)\s*(?:\|[^|]*\|)?\s*$/.test(stripComment(line))) continue;
    const path = m[4]!;
    const end = blockEnd(lines, i, m[1]!);
    const body = lines.slice(i + 1, end);
    const route: RouteInfo = {
      path,
      httpMethod: m[2]!.toUpperCase(),
      kind: "api",
      handler: null,
      calls: [],
      middleware: [],
      line: i + 1,
    };
    const applicable = inherited.filter((g) => !g.prefix || path.startsWith(g.prefix)).map((g) => g.guard);
    applyRouteMeta(route, {
      inheritedGuards: applicable,
      guards: guardsInBody(body),
      params: paramsFromAccess(extractRubyRequestAccess(body), path),
    });
    routes.push(route);
  }
  return routes;
}

/**
 * A controller's filters as class decorators, written out whole:
 * `before_action :conversation`, `before_action :set_user only: show,update`,
 * `skip_before_action :authenticate except: index`. The project pass that puts
 * a route on its action (rails-route-anchor) reads them up the class chain:
 * an action runs its filters before its own body.
 */
export function filterDecorators(lines: string[], cls: ClassInfo): string[] {
  const out: string[] = [];
  for (const d of collectFilters(lines, cls)) {
    if (d.kind === "macro" || d.names.length === 0) continue;
    const scope = (d.only ? ` only: ${[...d.only].join(",")}` : "") + (d.except.size > 0 ? ` except: ${[...d.except].join(",")}` : "");
    for (const name of d.names) out.push(`${d.kind === "skip" ? "skip_before_action" : "before_action"} :${name}${scope}`);
  }
  return out;
}
