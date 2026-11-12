import { rspecFunctions, withDescribedClass } from "./rspec.js";
import { rubyBlockEndsOf, rubyCodeLinesOf } from "./blocks.js";
import { extractRubyScheduledJobs } from "./scheduled-jobs.js";
import { addJobDispatchCalls, extractJobQueueSources } from "./active-job.js";
import { addConcernClassMethods } from "./concerns.js";
import { deviseForFact, extractDeviseFacts } from "./devise-routes.js";
import { addMacroMembers } from "./member-macros.js";
import { ACTIVE_RECORD_ASSOCIATION_MACROS } from "./entities.js";
import { addScopeMethods, extractModelSelfQueries } from "./model-scopes.js";
import { RAILS_RENDER_CALL_PATTERNS } from "./render-patterns.js";
import { rubyModelFinders } from "./autoload.js";
import type { CallInfo, RouteInfo, RouteFact, ClassInfo, FunctionInfo, DataSourceInfo, HttpClientRegistration, CallBaseRef } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractCallsFromBody, extractClassesWithSpec, splitTopLevel } from "../shared/regex-base.js";
import { escapeRegex } from "../shared/path-utils.js";
import { addRubyWhereFields, withRubyArgOrigins, withRubyArgOriginsInClasses } from "./arg-origins.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta } from "../../shared/route-metadata.js";
import {
  applyControllerMeta,
  extractRubyRequestAccess,
  extractSinatraRoutes,
  isSinatraFile,
  propagateHelperAccess,
  filterDecorators,
} from "./route-meta.js";
import {
  RUBY_DI_CALL_PATTERNS,
  applyDeclaredParamTypes,
  assignedFieldTypes,
  memoizedReturn,
  autoInjectProperties,
  collectIvarProperties,
  dropDetachedMemberCalls,
  extractRubyDiBindings,
  extractRubyLocalTypes,
  isAutoInjectInclude,
  parseRubyParam,
  separateSingletonMethods,
  typeBareConstructions,
} from "./di.js";
import { addAnonymousClassCalls, declaredByLets, type Anonymous } from "./anonymous-classes.js";
import { blockParamsOf } from "./block-params.js";
import { extractRubyResponses } from "./responses.js";
import { extractRubyTestRequests } from "./request-specs.js";
import { extractGrapeRoutes, extractRackMounts, isGrapeFile } from "./grape.js";
import { rubyModuleBindings } from "./module-bindings.js";

/** The helper name of a `resources … as: :teams` route: `teams`, `team`, `new_team`, `edit_team`. */
function resourceHelper(prefix: string, as: string, action: string, singular: boolean): string {
  const member = singular ? as : railsSingularize(as);
  if (action === "new") return `new_${prefix}${member}`;
  if (action === "edit") return `edit_${prefix}${member}`;
  const collection = action === "index" || action === "create";
  return prefix + (singular ? as : collection ? as : member);
}

/** Rails RESTful action → HTTP method + URL shape (plural `resources`). */
const RAILS_ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  index:   { method: "GET",    suffix: "" },
  show:    { method: "GET",    suffix: "/:id" },
  new:     { method: "GET",    suffix: "/new" },
  edit:    { method: "GET",    suffix: "/:id/edit" },
  create:  { method: "POST",   suffix: "" },
  update:  { method: "PUT",    suffix: "/:id" },
  destroy: { method: "DELETE", suffix: "/:id" },
};

/** Singular `resource` action map — no `index`, and the member has no `/:id`. */
const SINGULAR_ACTION_MAP: Record<string, { method: string; suffix: string }> = {
  new:     { method: "GET",    suffix: "/new" },
  edit:    { method: "GET",    suffix: "/edit" },
  show:    { method: "GET",    suffix: "" },
  create:  { method: "POST",   suffix: "" },
  update:  { method: "PUT",    suffix: "" },
  destroy: { method: "DELETE", suffix: "" },
};

/**
 * Parse a `resources` declaration's `only:`/`except:` action filter (both
 * `only: [:a, :b]` and the hash-rocket `:only => [:a]` spellings). `only`
 * is null when absent (= all actions); `except` defaults to empty.
 */
function parseActionFilter(stmt: string): { only: Set<string> | null; except: Set<string> } {
  let only: Set<string> | null = null;
  const except = new Set<string>();
  const onlyM = stmt.match(/(?:\bonly\s*:|:only\s*=>)\s*(\[[^\]]*\]|%[iI][\[(][^\])]*[\])]|:\w+)/);
  if (onlyM) only = new Set(actionSymbols(onlyM[1]!));
  const exceptM = stmt.match(/(?:\bexcept\s*:|:except\s*=>)\s*(\[[^\]]*\]|%[iI][\[(][^\])]*[\])]|:\w+)/);
  if (exceptM) for (const a of actionSymbols(exceptM[1]!)) except.add(a);
  return { only, except };
}

/** `[:a, :b]` / `:a` → its symbols; `%i[a b]` → its words. */
function actionSymbols(list: string): string[] {
  if (/^%[iI]/.test(list)) return list.slice(3, -1).split(/\s+/).filter(Boolean);
  return [...list.matchAll(/:(\w+)/g)].map((m) => m[1]!);
}

/** Actions Rails maps onto the scope's own path inside `collection`/`member` (`delete :destroy` → `DELETE /players`). */
const CANONICAL_ACTIONS = new Set(["index", "create", "new", "show", "update", "destroy"]);

/**
 * Controllers provided by Rails / its engines, not the application. Routes that
 * point at these (e.g. `get "/rails/mailers" => "rails/mailers#index"`, the
 * dev-only mailer preview) have no project source, so we drop them rather than
 * surface a handler-less "no code" route.
 */
/**
 * The routes `mount_devise_token_auth_for` draws, relative to its mount, as the gem documents
 * them (docs/usage: "Mounted routes"): each with the controller group a `controllers:` /
 * `skip:` option names and the action that serves it. `/:provider` only redirects to the
 * OmniAuth middleware, so no controller action serves it.
 */
const DEVISE_TOKEN_AUTH_ROUTES: ReadonlyArray<{ path: string; method: string; group: string; action: string | null }> = [
  { path: "", method: "POST", group: "registrations", action: "create" },
  { path: "", method: "DELETE", group: "registrations", action: "destroy" },
  { path: "", method: "PUT", group: "registrations", action: "update" },
  { path: "/sign_in", method: "POST", group: "sessions", action: "create" },
  { path: "/sign_out", method: "DELETE", group: "sessions", action: "destroy" },
  { path: "/:provider", method: "GET", group: "omniauth_callbacks", action: null },
  { path: "/:provider/callback", method: "GET", group: "omniauth_callbacks", action: "omniauth_success" },
  { path: "/:provider/callback", method: "POST", group: "omniauth_callbacks", action: "omniauth_success" },
  { path: "/validate_token", method: "GET", group: "token_validations", action: "validate_token" },
  { path: "/password", method: "POST", group: "passwords", action: "create" },
  { path: "/password", method: "PUT", group: "passwords", action: "update" },
  { path: "/password/edit", method: "GET", group: "passwords", action: "edit" },
  { path: "/confirmation", method: "POST", group: "confirmations", action: "create" },
];

/**
 * What a mounted devise_token_auth action does to the model the mount names, as the gem
 * documents it: sessions authenticate (read), registrations change the account (write),
 * password and confirmation requests store a token (write), the password form and
 * `validate_token` look the account up (read). `omniauth_success` is left out: it varies by provider.
 */
const DEVISE_TOKEN_AUTH_ACCESS: Readonly<Record<string, "read" | "write">> = {
  "sessions#create": "read",
  "sessions#destroy": "read",
  "registrations#create": "write",
  "registrations#update": "write",
  "registrations#destroy": "write",
  "token_validations#validate_token": "read",
  "passwords#create": "write",
  "passwords#update": "write",
  "passwords#edit": "read",
  "confirmations#create": "write",
};

const FRAMEWORK_CONTROLLER_RE = /^(rails|active_admin|action_cable|action_mailbox|active_storage)\b/;

/** `supervision_time_schedules` / `reports/positions` → `SupervisionTimeSchedules` / `Positions` */
/** `admin/billing` → `Admin::Billing` — a `module:` option names a module path. */
function railsModule(path: string): string {
  return path.split("/").filter(Boolean).map(railsCamelize).join("::");
}

function railsCamelize(token: string): string {
  return token
    .split(/[_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * The controllers a router hands to a gem's own routing DSL by name —
 * `devise_for :users, controllers: { sessions: 'staff/sessions' }`,
 * `mount_devise_token_auth_for … controllers: {…}`, Doorkeeper's
 * `controllers applications: 'oauth/applications'` — as Rails class names
 * (`Staff::SessionsController`). The gem draws their routes, so an action the
 * router never names may still be served: the route anchor keeps its guess.
 */
function extractGemRoutedControllers(lines: readonly string[], facts?: RouteFact[]): void {
  if (!facts || !lines.some((l) => /\.routes\.draw\b/.test(l))) return;
  const code = rubyCodeLinesOf(lines);
  for (let i = 0; i < code.length; i++) {
    const at = /\bcontrollers\b(?::|\s+(?=:?\w+:|:\w+\s*=>))/.exec(code[i] ?? "");
    if (!at) continue;
    // The hash may span lines: read on to its closing brace, or to the end of a bare argument list.
    let text = code[i]!.slice(at.index);
    for (let k = i + 1; k < code.length && k < i + 20; k++) {
      const braces = (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
      if (braces <= 0 && !/,\s*$/.test(text)) break;
      text += " " + code[k]!.trim();
    }
    const names = [...text.matchAll(/(?:\b\w+:|:\w+\s*=>)\s*['"]([\w/]+)['"]/g)].map((m) => railsControllerClass(m[1]!));
    if (names.length > 0) facts.push({ kind: "rails-gem-controllers", line: i + 1, data: names });
  }
}

/**
 * A `controller` token → its Rails class name: `session` → `SessionController`,
 * `admin/users` → `Admin::UsersController` (a directory is a module). The
 * enclosing `namespace` modules, if any, are prepended by the caller.
 */
function railsControllerClass(controllerToken: string, modules: readonly string[] = []): string {
  const segs = controllerToken.split("/").filter(Boolean);
  const leaf = railsCamelize(segs.pop() ?? controllerToken) + "Controller";
  return [...modules, ...segs.map(railsCamelize), leaf].join("::");
}

/**
 * Ruby calls a method without parentheses: in `agents.find(params[:id])` with
 * no local or parameter named `agents`, `agents` is a call of the method (a
 * memoizer like `def agents; @agents ||= …`). The chain alone recorded only
 * `agents.find`, so the method — and what it loads — was never reached.
 */
/**
 * A method's body as `[line index, text]` pairs: the lines between `def` and
 * `end`, or — for a method on one line — the text after an endless method's
 * `=` (`def range = window.current`) or after `def name;` (`def x; y; end`),
 * the declaration blanked before it so columns still line up.
 */
function bodyLines(lines: readonly string[], fn: FunctionInfo): Array<[number, string]> {
  if (fn.endLine > fn.line) {
    const out: Array<[number, string]> = [];
    for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) out.push([i, lines[i] ?? ""]);
    return out;
  }
  const decl = lines[fn.line - 1] ?? "";
  // A one-line spec block (`it { expect(club.total).to eq(3) }`) is all body.
  if (fn.testCase) return [[fn.line - 1, decl]];
  const def = decl.search(/\bdef\b/);
  const name = fn.name.replace(/^self\./, "");
  const at = def < 0 ? -1 : decl.indexOf(name, def + 3);
  if (at < 0) return [];
  const col = rubyInlineBodyColumn(decl, at + name.length);
  if (col < 0) return [];
  return [[fn.line - 1, " ".repeat(col) + decl.slice(col)]];
}

/**
 * Where a one-line method's body starts on its `def` line: after an endless
 * method's `=` (`def range = window.current`), after the `;` that ends the
 * signature (`def x; y; end`, `def f(a); g(a); end`), or after a parenthesized
 * parameter list followed by code (`def f(a) g(a) end`). `from` is the end of
 * the method's name. -1 when the body starts on the next line.
 */
export function rubyInlineBodyColumn(line: string, from: number): number {
  let k = from;
  while (line[k] === " " || line[k] === "\t") k++;
  let parens = false;
  if (line[k] === "(") {
    let depth = 0;
    for (; k < line.length; k++) {
      if (line[k] === "(") depth++;
      else if (line[k] === ")" && --depth === 0) break;
    }
    if (depth !== 0) return -1;
    k++;
    parens = true;
  }
  const rest = line.slice(k);
  const lead = rest.length - rest.trimStart().length;
  const next = rest.trimStart();
  if (next === "" || next.startsWith("#")) return -1;
  if (/^=(?![=~>])/.test(next)) return k + lead + 1;
  if (next.startsWith(";")) return k + lead + 1;
  // `def look a, b` — parameters without parentheses, up to a `;` when on one line.
  if (!parens) {
    const semi = line.indexOf(";", k);
    return semi < 0 ? -1 : semi + 1;
  }
  return lead > 0 ? k + lead : -1;
}

/**
 * The names a method binds as locals, wherever in its body: its parameters,
 * `x =` / `x ||=`, `a, b = …` (multiple assignment), block parameters
 * `|a, (b, c)|`, `rescue => e` and `for x in`. A bare name among them is the
 * local, never a call of a same-named method.
 */
function boundLocals(lines: readonly string[], fn: FunctionInfo): Set<string> {
  const bound = new Set(fn.params.map((p) => p.name));
  for (const [, text] of bodyLines(lines, fn)) {
    const code = text.replace(/#.*$/, "");
    for (const m of code.matchAll(/(?:^|[^\w.@:])([a-z_]\w*)\s*(?:\|\|)?=(?![=~>])/g)) bound.add(m[1]!);
    const multiple = /^\s*\(?\*?([a-z_]\w*(?:\s*(?:\)\s*)?,\s*\(?\*?[a-z_]\w*)+)\s*(?:\)\s*)?=(?![=~>])/.exec(code);
    if (multiple) for (const n of multiple[1]!.split(",")) bound.add(n.replace(/[()*\s]/g, ""));
    for (const m of code.matchAll(/\|([^|]*)\|/g)) for (const n of m[1]!.split(",")) bound.add(n.trim().replace(/^[*&(]+|[)]+$/g, "").replace(/\s*[=:].*$/, ""));
    const rescued = /\brescue\b[^#]*=>\s*([a-z_]\w*)/.exec(code);
    if (rescued) bound.add(rescued[1]!);
    const loop = /^\s*for\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s+in\b/.exec(code);
    if (loop) for (const n of loop[1]!.split(",")) bound.add(n.trim());
  }
  return bound;
}

/** `@name` as a whole word on the line: an instance variable, never a method call. */
function mentionsInstanceVariable(line: string, name: string): boolean {
  const needle = `@${name}`;
  for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + 1)) {
    if (!/\w/.test(line[at + needle.length] ?? "")) return true;
  }
  return false;
}

/**
 * `self.class.empty_table` in an instance method calls the class method of the class it is written in: named
 * through that class (`Standings.empty_table`), as a call written on the class is, and the step it reads first
 * (`self.class.empty_table.except(…)`) is a call of its own. Only a class method the class itself declares: one
 * it inherits or a library adds (`self.class.get` through HTTParty) is not the instance method of that name. A
 * module's `self.class` is its includer's, which the module does not name, and a class method's `self.class` is
 * `Class`: both are left as written.
 */
function addOwnClassCalls(lines: readonly string[], cls: ClassInfo, fn: FunctionInfo): void {
  if (fn.classLevel || !/^\s*class\b/.test(lines[cls.line - 1] ?? "")) return;
  const classMethods = new Set(cls.methods.filter((x) => x.classLevel).map((x) => x.name));
  if (classMethods.size === 0) return;
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  const extra: CallInfo[] = [];
  for (const c of fn.calls) {
    const m = /^(?:self\.)?class\.([a-z_]\w*[?!]?)((?:\.[a-z_]\w*[?!]?)*)$/.exec(c.name);
    if (!m || !classMethods.has(m[1]!)) continue;
    c.name = `${cls.name}.${m[1]}${m[2]}`;
    const first = `${cls.name}.${m[1]}`;
    if (m[2] && !have.has(`${first}@${c.line}`)) {
      have.add(`${first}@${c.line}`);
      extra.push({ name: first, kind: "internal", target: null, line: c.line, ...(c.column !== undefined ? { column: c.column } : {}) });
    }
  }
  fn.calls.push(...extra);
}

const IMPLICIT_RECEIVER_SKIP = new Set(["self", "params", "request", "response", "session", "cookies", "flash", "headers", "super", "nil", "true", "false", "logger", "render", "redirect_to", "head", "it", "yield"]);
function addImplicitReceiverCalls(lines: readonly string[], fn: FunctionInfo, bound: ReadonlySet<string>): void {
  const have = new Set(fn.calls.map((c) => c.name));
  const extra: CallInfo[] = [];
  for (const c of fn.calls) {
    const root = /^([a-z_]\w*)\./.exec(c.name)?.[1];
    if (!root || bound.has(root) || IMPLICIT_RECEIVER_SKIP.has(root) || have.has(root)) continue;
    // Call names drop an instance variable's `@` (`@repo&.find` → `repo.find`): that is no method call.
    if (mentionsInstanceVariable(lines[c.line - 1] ?? "", root)) continue;
    have.add(root);
    extra.push({ name: root, kind: "internal", target: null, line: c.line });
  }
  fn.calls.push(...extra);
}

/**
 * A bare name that is one of the class's own methods is a call of it:
 * `@players = players`, `create_contract` on its own line,
 * `raise Full unless squad_has_room?`. Ruby needs no parens or `self.`, so the
 * call patterns, which need evidence, miss these; the class's own method list
 * is that evidence. A name the method binds as a local or parameter is the
 * local, and a `:name` symbol, `name:` key or `.name` member is no own call.
 */
function addOwnMethodCalls(lines: readonly string[], cls: ClassInfo, fn: FunctionInfo, bound: ReadonlySet<string>): void {
  const own = new Set(cls.methods.map((m) => m.name).filter((n) => !/^self\./.test(n) && n !== "initialize"));
  if (own.size === 0) return;
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  for (const [i, text] of bodyLines(lines, fn)) {
    // Strings and comments are no code.
    const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/#.*$/, "");
    for (const m of code.matchAll(/(?<![\w.@$:])([a-z_]\w*[?!]?)(?![\w(:]|\s*(?:\|\|)?=[^=~>])/g)) {
      const name = m[1]!;
      if (!own.has(name) || bound.has(name) || /\bdef\s+$/.test(code.slice(0, m.index))) continue;
      if (have.has(`${name}@${i + 1}`)) continue;
      have.add(`${name}@${i + 1}`);
      fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
    }
  }
}

/** `NAMES = %i[a b]` / `NAMES = [:a, :b]` constants of a class body → their symbols (a list of anything else is none). */
function symbolListConstants(lines: readonly string[], cls: ClassInfo): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const head = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(%i[\[({]|\[)(.*)$/.exec(lines[i] ?? "");
    if (!head) continue;
    const percent = head[2]!.startsWith("%");
    const close = percent ? /[\])}]/ : /\]/;
    let text = head[3]!;
    for (let j = i + 1; !close.test(text) && j < Math.min(cls.endLine, lines.length, i + 40); j++) text += ` ${lines[j] ?? ""}`;
    const end = text.search(close);
    if (end < 0) continue;
    const body = text.slice(0, end).replace(/#.*$/, "");
    const names = percent ? body.split(/\s+/).filter(Boolean) : body.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (/^:([a-z_]\w*[?!]?)$/.exec(t) ?? [])[1] ?? "");
    if (names.length > 0 && names.every((n) => /^[a-z_]\w*[?!]?$/.test(n))) out.set(head[1]!, names);
  }
  return out;
}

/**
 * `send(name)` where the class gates `name` by a constant list of symbols
 * (`EVENTS.include?(name)`, in the sending method or in the method `name`
 * that yields it): the call is to each listed method the class defines.
 */
function addSymbolListDispatchCalls(lines: readonly string[], code: readonly string[], cls: ClassInfo, fn: FunctionInfo): void {
  const body = bodyLines(code, fn);
  const sends: Array<{ arg: string; line: number }> = [];
  for (const [i, text] of body) {
    const m = /(?<![\w.@$:])(?:self\.)?(?:public_send|__send__|send)\(?\s*([a-z_]\w*[?!]?)\s*(?:[,)]|$)/.exec(text);
    if (m) sends.push({ arg: m[1]!, line: i + 1 });
  }
  if (sends.length === 0) return;
  const constants = symbolListConstants(lines, cls);
  if (constants.size === 0) return;
  const own = new Set(cls.methods.map((x) => x.name));
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  for (const send of sends) {
    const yielder = cls.methods.find((x) => x.name === send.arg);
    const text = [...body, ...(yielder ? bodyLines(code, yielder) : [])].map(([, t]) => t).join("\n");
    for (const [name, symbols] of constants) {
      if (!new RegExp(`\\b${name}\\.(?:include|member)\\?|\\.in\\?\\(\\s*${name}\\b`).test(text)) continue;
      for (const sym of symbols) {
        if (!own.has(sym) || have.has(`${sym}@${send.line}`)) continue;
        have.add(`${sym}@${send.line}`);
        fn.calls.push({ name: sym, kind: "internal", target: null, line: send.line });
      }
    }
  }
}

/**
 * `def look a, b` — parameters written without parentheses, up to a `;` or
 * comment. The shared reader takes a list only in parentheses.
 */
function addParenlessParams(lines: readonly string[], fn: FunctionInfo): void {
  if (fn.params.length > 0) return;
  const decl = lines[fn.line - 1] ?? "";
  const name = fn.name.replace(/^self\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\bdef\\s+(?:(?:self|[A-Z]\\w*)\\.)?${name}[ \\t]+(?![=(;#])([^;#]+)`).exec(decl);
  if (!m) return;
  for (const p of splitTopLevel(m[1]!.trim())) {
    const param = parseRubyParam(p);
    if (param?.name && /^[*&]{0,2}[a-z_]\w*:?$|^\.\.\.$/.test(param.name)) fn.params.push(param);
  }
}

/** Words that stand alone on a line without calling anything. */
const BARE_STATEMENT_KEYWORDS = new Set([
  "end", "else", "elsif", "begin", "ensure", "rescue", "retry", "redo", "next", "break", "return", "super",
  "self", "nil", "true", "false", "yield", "then", "do", "private", "protected", "public", "module_function",
  "__method__", "__FILE__", "__LINE__", "__dir__", "binding", "raise", "loop", "puts", "p", "pp", "it",
]);

/**
 * A line that is one bare name the method does not bind — `tally`,
 * `authorize!`: Ruby reads an unbound identifier as a call on `self`, and a
 * statement that only reads a value does nothing, so the name is a method the
 * class has from itself, a module it mixes in or a base. The own-method pass
 * covers the class's own methods; this one the rest, which another file
 * declares.
 */
function addBareStatementCalls(lines: readonly string[], cls: ClassInfo, fn: FunctionInfo, locals: ReadonlySet<string>): void {
  const bound = new Set(locals);
  // A reader the class declares (`attr_reader :scope`) or forwards (`delegate :name, to: :club`) is no method of an ancestor.
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const decl = /^\s*(?:attr_reader|attr_accessor|delegate)\b\s*\(?\s*(:[\w?!]+(?:\s*,\s*:[\w?!]+)*)/.exec(lines[i] ?? "");
    if (decl) for (const n of decl[1]!.matchAll(/:([\w?!]+)/g)) bound.add(n[1]!);
  }
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  for (const [i, text] of bodyLines(lines, fn)) {
    const m = /^\s*([a-z_]\w*[?!]?)\s*(?:#.*)?$/.exec(text);
    if (!m) continue;
    const name = m[1]!;
    if (bound.has(name) || BARE_STATEMENT_KEYWORDS.has(name) || have.has(`${name}@${i + 1}`)) continue;
    have.add(`${name}@${i + 1}`);
    fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
  }
}

/**
 * A bare `super` / `super(args)` is a call of the method's own name on the ancestor — the
 * way an override reaches what a gem's base class does (`def update; …; super; end`).
 * Recorded as a call named `super`; core and the route pass decide what it reaches.
 */
function addSuperCalls(lines: readonly string[], fn: FunctionInfo): void {
  if (fn.calls.some((c) => c.name === "super")) return;
  for (const [i, text] of bodyLines(lines, fn)) {
    const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/#.*$/, "");
    if (/(?<![\w.@$:])super(?![\w?!:])/.test(code)) {
      fn.calls.push({ name: "super", kind: "internal", target: null, line: i + 1 });
      return;
    }
  }
}

/** A chain off a class through a model finder or query (`Club.find()`, `Club.where().first()`). */
const MODEL_FINDER_CHAIN = new RegExp(`^[A-Z][\\w:]*\\.(?:${rubyModelFinders.members.map(escapeRegex).join("|")})\\(\\)`);

/**
 * `builder.perform` on a local the method constructed (`builder = PlayerBuilder.new(…)`):
 * a paren-less call the call patterns cannot tell from an attribute read, but
 * the local's stated type makes it a member of that class.
 */
function addTypedLocalCalls(lines: readonly string[], fn: FunctionInfo, elementHeads: ReadonlySet<string> = new Set()): void {
  // Typed by its construction, or by the model finder it is assigned (`club = Club.find(id)`), or the element of a typed collection a block iterates.
  // An instance variable typed by what assigns it (`field`) is written `@club.promote`.
  const typed = (fn.localTypes ?? []).filter((l) => (l.field ? l.type || l.from : l.type || MODEL_FINDER_CHAIN.test(l.from ?? "")) || elementHeads.has(l.name));
  if (typed.length === 0) return;
  const fields = new Set(typed.filter((l) => l.field).map((l) => l.name));
  const plain = new Set(typed.filter((l) => !l.field).map((l) => l.name));
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  const re = new RegExp(`(?<![\\w.@$:])(@?)(${[...new Set(typed.map((l) => l.name))].join("|")})\\.([a-z_]\\w*[?!]?)(?![\\w(]|\\s*=[^=~>])`, "g");
  for (const [i, text] of bodyLines(lines, fn)) {
    const code = text.replace(/\s#.*$/, "");
    for (const m of code.matchAll(re)) {
      if (!(m[1] === "@" ? fields : plain).has(m[2]!)) continue;
      const name = `${m[2]}.${m[3]}`;
      if (have.has(`${name}@${i + 1}`)) continue;
      have.add(`${name}@${i + 1}`);
      fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
    }
  }
}

/**
 * The parameters of the method's blocks (`team.players.each { |player| … }`): each is a local of unknown
 * type (`untypedLocals`, so the linker never guesses its calls by name), or — where the iterated
 * collection is a typed association or model query — the first element of it (`localTypes[].from`).
 * Returns the names so typed.
 */
function addBlockParamTypes(lines: readonly string[], fn: FunctionInfo, associations: ReadonlySet<string>, bound: ReadonlySet<string>): Set<string> {
  const heads = new Set<string>([...associations].filter((n) => !bound.has(n)));
  for (const l of fn.localTypes ?? []) if (l.type || MODEL_FINDER_CHAIN.test(l.from ?? "")) heads.add(l.name);
  const elements = new Set<string>();
  for (const p of blockParamsOf(bodyLines(lines, fn), heads, (chain) => MODEL_FINDER_CHAIN.test(chain))) {
    // A name the method states otherwise (a parameter, an assigned local) is that, not the block's.
    if (fn.params.some((x) => x.name === p.name) || fn.localTypes?.some((l) => l.name === p.name)) continue;
    if (p.from) {
      (fn.localTypes ??= []).push({ name: p.name, type: "", from: p.from });
      elements.add(p.name);
    }
    (fn.untypedLocals ??= []).push(p.name);
  }
  return elements;
}

/** A head read off a reader method of the class's own (`self.club()`), which the linker types by what it returns. */
const SELF_READER = /^self\.[a-z_]\w*[?!]?\(\)$/;

/**
 * `club.award_honours` where `club` is no local but a memoizing reader of the class (`readers`, each with its
 * `returnedFrom`): the head is the reader's result, a local typed from `self.club()` as an association reader's is.
 * Only a name the method binds nowhere.
 */
function addReaderHeads(lines: readonly string[], fn: FunctionInfo, readers: ReadonlySet<string>, bound: ReadonlySet<string>): void {
  for (const x of readers) {
    if (x === fn.name || bound.has(x) || fn.localTypes?.some((l) => l.name === x)) continue;
    const head = new RegExp(`(?<![\\w@$:.])${escapeRegex(x)}\\.[a-z_]`);
    if (!fn.calls.some((d) => d.name.startsWith(`${x}.`)) && !bodyLines(lines, fn).some(([, t]) => head.test(t))) continue;
    (fn.localTypes ??= []).push({ name: x, type: "", from: `self.${x}()` });
  }
}

/** The association readers a model class declares: `has_many :players` → `players` (a chain off it is typed by the reader). */
const ASSOCIATION_READER = new RegExp(String.raw`^\s*(?:${ACTIVE_RECORD_ASSOCIATION_MACROS.join("|")})\s*\(?\s*:([a-z_]\w*)`);
function associationNames(lines: readonly string[], cls: ClassInfo): Set<string> {
  const out = new Set<string>();
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const m = ASSOCIATION_READER.exec(lines[i] ?? "");
    if (m) out.add(m[1]!);
  }
  return out;
}

/**
 * A chain read off a typed local or an association reader the class declares — `club.players.first.train`,
 * `league.clubs.last.promote` — written without parentheses, which the call patterns leave to their evidence rules.
 * The head's type is the evidence: the linker follows each step through the reader's or method's declared return
 * type and links only a chain it can type to the end. An association name no local of the method shadows is typed
 * as the reader (`localTypes` from `self.players`).
 */
function addMemberChainCalls(lines: readonly string[], fn: FunctionInfo, associations: ReadonlySet<string>, bound: ReadonlySet<string>): void {
  const members = [...associations].filter((n) => !bound.has(n));
  const heads = new Set<string>(members);
  // An instance variable typed by what assigns it (`field`) heads a chain as `@club.reload.award_honours`.
  const fields = new Set<string>();
  const plain = new Set<string>(members);
  for (const l of fn.localTypes ?? []) {
    if (!(l.field ? l.type || l.from : l.type || MODEL_FINDER_CHAIN.test(l.from ?? "") || SELF_READER.test(l.from ?? ""))) continue;
    heads.add(l.name);
    (l.field ? fields : plain).add(l.name);
  }
  // An instance variable the method does not type, reloaded or locked before the call (`@club.reload.award_honours`):
  // a filter that runs before the method may type it (the plugin's project pass), and the call named without its
  // head (`reload.award_honours`) could not be followed. Only through a step that returns the record itself — any other
  // chain off an untyped head is left as it was. A name the method also binds or calls bare is left alone.
  const bare = new Set(fn.calls.filter((c) => !c.name.includes(".")).map((c) => c.name));
  const selfSteps = new Set<string>();
  for (const [, text] of bodyLines(lines, fn)) {
    if (!text.includes("@")) continue;
    for (const m of text.matchAll(/(?<![\w@$:.])@([a-z_]\w*)\.(?:reload|lock!)(?:\(\))?\.[a-z_]/g)) {
      const n = m[1]!;
      if (fields.has(n) || bound.has(n) || bare.has(n) || plain.has(n) || fn.localTypes?.some((l) => l.name === n && !l.field)) continue;
      heads.add(n);
      selfSteps.add(n);
    }
  }
  if (heads.size === 0) return;
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  // A step may carry arguments (`players.find_by(id: 1).injure!`): they are dropped from the name, as the steps' types
  // do not depend on them. One level of nested parentheses is read.
  const re = new RegExp(`(?<![\\w.@$:])(@?)(${[...heads].join("|")})((?:\\.[a-z_]\\w*[?!]?(?:\\((?:[^()]|\\([^()]*\\))*\\))?){2,4})(?![\\w?!]|\\s*=[^=~>])`, "g");
  for (const [i, text] of bodyLines(lines, fn)) {
    const code = text.replace(/\s#.*$/, "");
    for (const m of code.matchAll(re)) {
      if (!(m[1] === "@" ? fields : plain).has(m[2]!) && !(m[1] === "@" && selfSteps.has(m[2]!) && /^\.(?:reload|lock!)\b/.test(m[3]!))) continue;
      const name = `${m[2]}${m[3]!.replace(/\((?:[^()]|\([^()]*\))*\)/g, "")}`;
      if (have.has(`${name}@${i + 1}`)) continue;
      have.add(`${name}@${i + 1}`);
      fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
    }
  }
  // The head of every dotted call name, once: `players.first` starts `players.`.
  const chained = new Set<string>();
  for (const c of fn.calls) {
    const dot = c.name.indexOf(".");
    if (dot >= 0) chained.add(c.name.slice(0, dot));
  }
  for (const n of members) {
    if (chained.has(n) && !fn.localTypes?.some((l) => l.name === n)) (fn.localTypes ??= []).push({ name: n, type: "", from: `self.${n}()` });
  }
}

/**
 * The typed-call passes a class's methods get (`addTypedLocalCalls`, `addJobDispatchCalls`), over
 * functions outside a class: top-level `def`s and spec blocks. Each reads only its own lines — a
 * spec group's examples, or a `def` written inside a block, are functions of their own — with
 * `described_class` spelled as the constant the block types it as.
 */
/** The innermost function holding a 1-based line. */
function holderOf(fns: readonly FunctionInfo[], line: number): FunctionInfo | undefined {
  return fns.filter((h) => h.line <= line && line <= h.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
}

/** The anonymous classes the `let`s of the groups around `fn` build, innermost group last (so it wins). */
function letClassesAround(code: readonly string[], fns: readonly FunctionInfo[], fn: FunctionInfo): Map<string, Anonymous> {
  const out = new Map<string, Anonymous>();
  const around = fns
    .filter((o) => o !== fn && o.line <= fn.line && o.endLine >= fn.endLine && (o.line < fn.line || o.endLine > fn.endLine))
    .sort((a, b) => b.endLine - b.line - (a.endLine - a.line));
  for (const o of around) {
    // A name `let` twice in one group is not one class: neither reading is kept.
    const mine = declaredByLets(code, o.line - 1, o.endLine);
    for (const found of mine) {
      const name = found.name;
      if (mine.some((x) => x !== found && x.name === name && holderOf(fns, x.line) === holderOf(fns, found.line))) { out.delete(name); continue; }
      // A `let` written in a nested group belongs to that group: the innermost function holding it must be one around `fn`.
      const holder = holderOf(fns, found.line);
      if (holder === o || (holder && around.includes(holder))) out.set(name, found);
    }
  }
  return out;
}

function addTypedCallsOverFunctions(lines: readonly string[], fns: readonly FunctionInfo[]): void {
  const hasLetClass = lines.some((l) => l.includes("Class.new(")) && lines.some((l) => /^\s*let!?\s*\(/.test(l));
  const code0 = hasLetClass ? rubyCodeLinesOf(lines) : [];
  const inheritedOf = new Map<FunctionInfo, Map<string, Anonymous>>();
  if (hasLetClass) for (const fn of fns) { const got = letClassesAround(code0, fns, fn); if (got.size) inheritedOf.set(fn, got); }
  const typed = fns.filter((fn) => inheritedOf.has(fn) || fn.localTypes?.length || lines.slice(fn.line - 1, fn.endLine).some((l) => l.includes(".perform_") || l.includes(".deliver_") || l.includes("Class.new(")));
  if (typed.length === 0) return;
  const code = rubyCodeLinesOf(lines);
  // One scratch view per source, filled over a function's span and cleared after it.
  const ownCode: string[] = new Array<string>(lines.length).fill("");
  const ownRaw: string[] = new Array<string>(lines.length).fill("");
  for (const fn of typed) {
    const from = fn.line - 1;
    const to = Math.min(fn.endLine, lines.length);
    for (let i = from; i < to; i++) {
      ownCode[i] = withDescribedClass(code[i] ?? "", fn);
      ownRaw[i] = withDescribedClass(lines[i] ?? "", fn);
    }
    for (const inner of fns) {
      if (inner === fn || inner.line <= fn.line || inner.endLine > fn.endLine) continue;
      for (let i = inner.line - 1; i < Math.min(inner.endLine, to); i++) ownCode[i] = ownRaw[i] = "";
    }
    addAnonymousClassCalls(ownCode, fn, code, inheritedOf.get(fn));
    addTypedLocalCalls(ownCode, fn);
    addJobDispatchCalls(ownRaw, fn);
    for (let i = from; i < to; i++) ownCode[i] = ownRaw[i] = "";
  }
}

/** `@x = a.b(…)` / `@x ||= A.b.c(…)` inside a class's methods → `{ x: "a.b(…)" }`, several chains one per line. */
function ivarAssignedChains(lines: string[], cls: ClassInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of cls.methods) {
    for (let i = m.line; i < Math.min(m.endLine, lines.length); i++) {
      const code = (lines[i] ?? "").replace(/#.*$/, "");
      const a = /@([a-z_]\w*)\s*(?:\|\|)?=\s*((?:[A-Z][\w:]*|[a-z_]\w*)(?:\.[a-z_]\w*[?!]?(?:\([^)]*\))?)+)/.exec(code);
      // Every chain assigned, one per line: the entity pass keeps the model they agree on.
      if (a && !(out[a[1]!] ?? "").split("\n").includes(a[2]!)) out[a[1]!] = out[a[1]!] ? `${out[a[1]!]}\n${a[2]}` : a[2]!;
      // `@model ||= @match`: the variable is another variable's value, typed where that one is assigned.
      const alias = a ? null : /^\s*@([a-z_]\w*)\s*(?:\|\|)?=\s*(@[a-z_]\w*)\s*$/.exec(code);
      if (alias && !(out[alias[1]!] ?? "").split("\n").includes(alias[2]!)) out[alias[1]!] = out[alias[1]!] ? `${out[alias[1]!]}\n${alias[2]}` : alias[2]!;
    }
  }
  return out;
}

/** Naive Rails inflector, the other way: `duties` → `duty`, `children` → `child`, `statuses` → `status`. */
function railsSingularize(token: string): string {
  const irregular: Record<string, string> = { children: "child", people: "person", men: "man", women: "woman" };
  if (irregular[token]) return irregular[token]!;
  if (/ies$/.test(token)) return token.replace(/ies$/, "y");
  if (/(ss|x|z|ch|sh)es$/.test(token)) return token.replace(/es$/, "");
  if (/s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * The modules a controller class is declared inside, outermost first — from
 * `module Staff … class DutiesController` nesting (the module is captured
 * as a class entry whose line range encloses the controller's) or from a
 * `class Staff::DutiesController` name. Rails maps them to a path prefix
 * and to the handler's qualified name: `app/controllers/staff/duties_
 * controller.rb` serves `/staff/duties`, not `/duties`, and calling it
 * `DutiesController` collides with the top-level controller of the same name.
 */
export function enclosingModules(cls: ClassInfo, classes: readonly ClassInfo[]): string[] {
  const fromNesting = classes
    .filter((m) => m !== cls && m.line < cls.line && (m.endLine ?? 0) >= (cls.endLine ?? cls.line) && !/Controller$/.test(m.name))
    .sort((a, b) => a.line - b.line)
    .map((m) => m.name);
  const parts = cls.name.split("::");
  parts.pop();
  return [...fromNesting.flatMap((n) => n.split("::")), ...parts];
}

/** `UserRole` / `Admin::BaseController` → `user_role` / `base_controller` — the
 *  Rails autoload file basename for a constant. Only the last `::` segment
 *  matters because autoloading maps each constant to its own file. */
function railsUnderscore(name: string): string {
  const last = name.split("::").pop() ?? name;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Naive Rails inflector: `user_role` → `user_roles`, `category` → `categories`.
 * A word already ending in `s` stays (`user_diagnostics`, `settings`) — Rails'
 * own rule — except `ss`/`us`/`is` endings (`address`, `status`, `analysis`).
 */
function railsPluralize(token: string): string {
  if (/[^aeiou]y$/.test(token)) return token.replace(/y$/, "ies");
  if (/(ss|us|is|x|z|ch|sh)$/.test(token)) return token + "es";
  if (/s$/.test(token)) return token;
  return token + "s";
}

/**
 * ActiveRecord query/persistence methods that mark a `Model.<method>` call-site
 * as database access. Reads and writes are both surfaced as `kind:"database"`
 * data sources — the regex path has no separate mutation channel, and what the
 * screen→API→DB chain needs is "this code touches entity X", which either
 * direction supplies. Only the HEAD of a chain matches (`Absence.where(..)`); the
 * lowercase relation receiver of a trailing `.order(..)` never re-triggers, so a
 * chained query yields exactly one source.
 */
const AR_QUERY_METHODS = new Set([
  "where", "all", "first", "last", "take", "pluck", "ids", "count", "count_by_sql", "sum",
  "average", "maximum", "minimum", "exists?", "any?", "many?", "none?",
  "includes", "joins", "left_joins", "left_outer_joins", "eager_load",
  "preload", "references", "group", "having", "order", "reorder", "limit",
  "offset", "distinct", "select", "none", "unscoped", "scoped",
  "create", "create!", "update", "update!", "update_all", "update_columns",
  "insert", "insert!", "insert_all", "insert_all!", "upsert", "upsert_all",
  "destroy", "destroy!", "destroy_all", "delete", "delete_all", "delete_by",
  "destroy_by", "first_or_create", "first_or_create!", "first_or_initialize",
  "touch_all", "increment_counter", "decrement_counter", "update_counters",
]);

/**
 * Capitalised constants that share method names with AR but are not models —
 * `File.delete`, `Dir.exists?`, `Time.now`. Denylisted (by their bare last
 * segment) so stdlib calls don't masquerade as DB access.
 */
const NON_MODEL_CONSTANTS = new Set([
  "File", "Dir", "Time", "Date", "DateTime", "Math", "JSON", "YAML", "Rails",
  "Kernel", "Hash", "Array", "String", "Integer", "Float", "Object", "Struct",
  "Set", "Logger", "URI", "Base64", "Digest", "OpenStruct", "Thread", "Mutex",
  "Process", "ENV", "GC", "Random", "Marshal", "Regexp", "Range", "Comparable",
  "Enumerable", "Module", "Class", "Proc", "Method", "Symbol", "NilClass",
]);

/**
 * `User.all` — a constant receiver with a paren-less member, excluding the
 * stdlib/framework constants above. Built from `NON_MODEL_CONSTANTS` so the
 * denylist has one home.
 */
const PARENLESS_CONST_CALL_RE = new RegExp(
  // The `?`/`!` of a predicate or bang method is part of its name (`is_holiday?`
  // is not `is_holiday`); a `!=` after the name is an operator.
  // A leading `::` names the top level (`::Contacts::FilterService.new`); the path is the same.
  `(?<![\\w.@$:])(?:::)?(?!(?:${[...NON_MODEL_CONSTANTS].join("|")})\\b)([A-Z]\\w*(?:::[A-Z]\\w*)*)\\.([a-z_]\\w*(?:[?!](?!=))?)`,
);

/**
 * What may follow a paren-less command call's method name to start its first argument: a number, string,
 * symbol, instance variable or name — which an attribute read never is. A keyword (`club.name if x`) is none.
 */
const RUBY_COMMAND_ARGUMENT = String.raw`(?:\d|["']|:\w|@\w|(?!(?:if|unless|while|until|and|or|not|do|then|rescue|ensure|end|in|when|else|elsif)\b)[a-z_]\w*\b(?![ \t]*[?:]\s))`;

/**
 * The receiver of a call through a path of readers as the call is named: safe navigation dropped
 * (`club&.league` → `club.league`), and one reader on the caller's own instance named as the reader
 * (`self.club` → `club`), as the parenthesized reader call is. `self.class` is no reader: it stays as written.
 */
function rubyPathReceiver(path: string): string {
  const plain = path.replace(/&\./g, ".");
  return /^self\.(?!class$)[a-z_]\w*$/.test(plain) ? plain.slice(5) : plain;
}

/** A (possibly namespaced) capitalised receiver, not preceded by `.`/word char,
 *  followed by a `.method`. Global — a line may hold several queries. */
const AR_CALL_RE = /(?<![\w.@$])([A-Z]\w*(?:::[A-Z]\w*)*)\.([a-z_]\w*[!?]?)/g;

/**
 * A receiver chain ending in a lowercase segment, then an AR verb:
 * `Current.account.conversations.find_by!`, `@conversation.messages.create!`,
 * `conversation.update!`. Segments may carry empty parens (`.messages()`),
 * never arguments — a chain through `find(id)` is cut there, which is right:
 * the verb after it runs on whatever that returned.
 */
const AR_CHAIN_RE = /(?<![\w.@$:])((?:@{1,2}|\$)?[A-Za-z_]\w*(?:(?:::[A-Z]\w*)*(?:\(\))?\.[a-z_]\w*)*)\.([a-z_]\w*[!?]?)(?=\s*(?:\(|$|\s|[,)\]}]))/g;

/** A query entry point: an explicit AR method, or any `find…` finder
 *  (`find`, `find_by`, `find_each`, dynamic `find_by_email`, app `find_authorized`). */
function isArQueryMethod(method: string): boolean {
  return AR_QUERY_METHODS.has(method) || /^find($|_)/.test(method);
}

/** ActiveRecord methods that MUTATE — feeds the dataflow-lite read/write split. */
const AR_WRITE_METHODS = new Set([
  "create", "create!", "update", "update!", "update_all", "update_columns",
  "insert", "insert!", "insert_all", "insert_all!", "upsert", "upsert_all",
  "destroy", "destroy!", "destroy_all", "delete", "delete_all", "delete_by",
  "destroy_by", "first_or_create", "first_or_create!", "touch_all",
  "increment_counter", "decrement_counter", "update_counters", "save", "save!",
  "update_attribute", "update_column", "toggle!", "increment!", "decrement!",
]);

/** Read/write nature of an AR method (a `find…`/query is a read). */
function arAccessKind(method: string): "read" | "write" {
  return AR_WRITE_METHODS.has(method) ? "write" : "read";
}

// ─── Outbound HTTP (api-call) detection ──────────────────────────────────────

/**
 * `RestClient.get`, `HTTParty.post`, `Faraday.delete`, `Typhoeus.get`,
 * `Excon.head` — module-level verb methods on the common Ruby HTTP client gems.
 * The verb (group 2) is the HTTP method; the first argument is the URL.
 */
const HTTP_CLIENT_RE =
  /\b(RestClient|HTTParty|Faraday|Typhoeus|Excon)\s*\.\s*(get|post|put|patch|delete|head|options)\b/g;

/**
 * `Net::HTTP::Post.new(uri)` / `Net::HTTP::Get.new(url)` — the stdlib request
 * class names the verb. Anchored to `.new` so `response.is_a?(Net::HTTPSuccess)`
 * (a *response* type, spelled `HTTPSuccess` without the `::Verb` segment) never
 * matches.
 */
const NET_HTTP_CLASS_RE =
  /\bNet::HTTP::(Get|Post|Put|Patch|Delete|Head|Options)\s*\.\s*new\b/g;

/** `Net::HTTP.get`, `Net::HTTP.post_form`, `Net::HTTP.get_response`, `.request_post`. */
const NET_HTTP_METHOD_RE =
  /\bNet::HTTP\s*\.\s*(get_response|post_form|request_get|request_post|get|post)\b/g;

/** Net::HTTP convenience method → HTTP verb. */
const NET_HTTP_METHOD_MAP: Record<string, string> = {
  get: "get",
  get_response: "get",
  request_get: "get",
  post: "post",
  post_form: "post",
  request_post: "post",
};

/**
 * Read the first argument of a call starting at `from` (the index just past the
 * matched verb token). Handles both Ruby call forms — parenthesised
 * `RestClient.get(url, headers)` and the paren-less "command call"
 * `RestClient.get url, headers` (the grammar's `command_call`) — and returns the
 * URL: a string literal with its quotes stripped, or the raw expression text
 * (`url`, `uri.request_uri`) as a best-effort label. Bracket- and quote-aware so
 * the argument boundary isn't mis-read inside `get_headers(a, b)` or `"a,b"`.
 */
function firstArgUrl(line: string, from: number): string | null {
  let i = from;
  while (i < line.length && /\s/.test(line[i]!)) i++;
  if (line[i] === "(") i++; // parenthesised form — step inside
  while (i < line.length && /\s/.test(line[i]!)) i++;

  const start = i;
  let depth = 0;
  let quote: string | null = null;
  for (; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) break;
  }

  const arg = line.slice(start, i).trim();
  return arg.length > 0 ? arg : null;
}

/**
 * The URL a first argument states: a string literal's text, a local bound to
 * one, else the expression as a Ruby interpolation hole (`#{url}`,
 * `#{CICO_API_URL}`) — a runtime value, never the path `/url`.
 */
function urlOfArg(arg: string | null, varLiterals: ReadonlyMap<string, string>): string | null {
  if (!arg) return null;
  // `Net::HTTP.get(URI("https://…"))`, `URI.parse("…")`: the URL the wrapper is built from.
  const wrapped = /^(?:URI|URI\.parse|Addressable::URI\.parse)\(\s*(['"][^'"]*['"])\s*\)$/.exec(arg);
  if (wrapped) arg = wrapped[1]!;
  const lit = arg.match(/^(['"])([\s\S]*)\1$/);
  if (lit) return lit[2]!;
  if (BARE_VAR_RE.test(arg) && varLiterals.has(arg)) return varLiterals.get(arg)!;
  return `#{${arg}}`;
}

/** `url = "#{BASE}/institution"` — a local var bound to a string literal. Group 1
 *  is the name, group 2 the quoted literal. Only literals are tracked (a method
 *  call RHS stays opaque, so the raw variable name remains the best label). */
const URL_ASSIGN_RE = /^\s*([a-z_]\w*)\s*=\s*(?!=)(['"])((?:[^\\]|\\.)*?)\2\s*$/;

/** A bare local-variable reference (no `.method`, no `(`) — resolvable via the
 *  file-local literal map; anything richer (`uri.request_uri`) stays verbatim. */
const BARE_VAR_RE = /^[a-z_]\w*$/;

/**
 * Surface outbound HTTP calls (`RestClient.get url`, `Net::HTTP::Post.new(uri)`,
 * `HTTParty.post(...)`) as `api-call` data sources — the backend→external-service
 * (and, in an API-only Rails app, the outbound-integration) half of the tracing
 * story that every other language plugin already provides. `name` is the bare
 * HTTP verb so the cross-tier route-linker can read it as the method; `target`
 * is the request URL when statically visible.
 *
 * The URL argument is almost always a local var built one line earlier
 * (`url = "#{LEAGUEDATA_API_URL}/institution"`), so a single top-to-bottom pass
 * keeps a file-local map of the most recent string-literal assignment per name
 * and resolves a bare-identifier target through it — reproducing `#{…}`
 * interpolations verbatim (as the JS/PHP URL resolvers do) so a concrete
 * endpoint path surfaces instead of the opaque variable name.
 */
/**
 * The names a file binds to a Faraday connection: a local or ivar assigned
 * `Faraday.new` (`conn = Faraday.new(url)`, `@connection ||= Faraday.new do`)
 * and a method whose body opens with one (`def connection` / `Faraday.new do`).
 * A request goes through that object, so `connection.post(url)` is the call;
 * a same-named object the file never binds to Faraday (a Redis `connection`) is not.
 */
function faradayConnectionNames(lines: string[]): RegExp | null {
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bFaraday(?:::Connection)?\s*\.\s*new\b/.test(line)) continue;
    const assigned = line.match(/^\s*(@?[a-z_]\w*)\s*(\|\|)?=\s*Faraday\b/);
    if (assigned) names.add(assigned[1]!);
    // A plain local (`conn = Faraday.new`) is not what the enclosing method returns.
    if (assigned && !assigned[2] && !assigned[1]!.startsWith("@")) continue;
    for (let j = i - 1; j >= 0 && i - j <= 2; j--) {
      const def = (lines[j] ?? "").match(/^\s*def\s+([a-z_]\w*)\s*$/)?.[1];
      if (def) { names.add(def); break; }
    }
  }
  if (names.size === 0) return null;
  return new RegExp(`(?<![\\w.@:])(${[...names].join("|")})\\s*\\.\\s*(get|post|put|patch|delete|head)\\b`, "g");
}

/** The base a `Faraday.new` is given: `url: "https://host"`, `"https://host"`, `ENV["X"]`, `ENV.fetch("X", "http://localhost:3000")`. */
function faradayBaseRef(args: string): CallBaseRef | null {
  const written = /^\(?\s*(?:url:\s*|:url\s*=>\s*)?(.+?)\s*(?:,\s*\w+:.*)?$/.exec(args)?.[1] ?? "";
  const lit = /^(['"])(https?:\/\/[^'"#]*)\1/.exec(written);
  if (lit) return { kind: "literal", key: lit[2]! };
  const env = /^ENV(?:\[\s*['"](\w+)['"]\s*\]|\.fetch\(\s*['"](\w+)['"]\s*(?:,\s*(['"])([^'"]*)\3)?\s*\))(?:\s*\|\|\s*(['"])([^'"]*)\5)?/.exec(written);
  if (!env) return null;
  const fallback = env[4] ?? env[6];
  return { kind: "env", key: (env[1] ?? env[2])!, ...(fallback && /^https?:\/\//.test(fallback) ? { fallback } : {}) };
}

/**
 * Faraday connections with a base: `conn = Faraday.new(url: "https://host")`, keyed by the name
 * the connection is bound to, which each `conn.get("/clubs")` row carries as its `client`.
 */
export function extractRubyHttpClientRegistrations(lines: string[]): HttpClientRegistration[] {
  const out: HttpClientRegistration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(@?[a-z_]\w*)\s*(?:\|\|)?=\s*Faraday(?:::Connection)?\s*\.\s*new\s*\(?\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const base = faradayBaseRef(m[2]!);
    if (base) out.push({ client: m[1]!, scope: "file", base, line: i + 1 });
  }
  return out;
}

function extractRubyHttpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const connectionCall = faradayConnectionNames(lines);
  const seen = new Set<string>();
  const varLiterals = new Map<string, string>();
  const push = (verb: string, rawArg: string | null, line: number, col: number, client?: string): void => {
    const target = urlOfArg(rawArg, varLiterals);
    const key = `${verb}:${target ?? ""}@${line}:${col}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: "api-call", name: verb, target, calls: [], line, ...(client ? { client } : {}) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const assign = URL_ASSIGN_RE.exec(line);
    if (assign) varLiterals.set(assign[1]!, assign[3]!);

    for (const m of line.matchAll(HTTP_CLIENT_RE)) {
      push(m[2]!.toLowerCase(), firstArgUrl(line, m.index! + m[0]!.length), i + 1, m.index!);
    }
    for (const m of line.matchAll(NET_HTTP_CLASS_RE)) {
      push(m[1]!.toLowerCase(), firstArgUrl(line, m.index! + m[0]!.length), i + 1, m.index!);
    }
    for (const m of line.matchAll(NET_HTTP_METHOD_RE)) {
      push(NET_HTTP_METHOD_MAP[m[1]!]!, firstArgUrl(line, m.index! + m[0]!.length), i + 1, m.index!);
    }
    if (connectionCall) {
      for (const m of line.matchAll(connectionCall)) {
        push(m[2]!, firstArgUrl(line, m.index! + m[0]!.length), i + 1, m.index!, m[1]!);
      }
    }
  }
  return out;
}

/**
 * Surface ActiveRecord access (`Match.find_authorized(..)`, `Club.where(..)`,
 * `Car.create!`, namespaced `League::MatchReport.all`) as `database`
 * data sources, so a controller/service method links to the entity it touches —
 * the backend half of the screen→API→DB chain. Per-file extraction can't see
 * cross-file types, so `entity` is set to the receiver's bare model name (matching
 * how the entity graph indexes its nodes); the shared enricher would otherwise
 * reject a `Ns::Model` receiver as a non-identifier.
 */
/** A line worth the chain scan: it calls an AR verb (or any `find…` finder) through a dot. */
const AR_VERB_GATE = new RegExp(`\\.(?:${[...AR_QUERY_METHODS, ...AR_WRITE_METHODS].map((v) => v.replace(/[!?]$/, "")).join("|")}|find\\w*)[!?]?(?=\\s*(?:\\(|$|\\s|[,)\\]}]))`);

/** The chain a local was last assigned earlier in the same method: `scope = Current.account.contacts` → that, args dropped. */
function localChainBefore(lines: string[], i: number, local: string): string | null {
  for (let j = i - 1; j >= 0 && i - j <= 30; j--) {
    const code = (lines[j] ?? "").replace(/#.*$/, "");
    if (/^\s*def\s/.test(code)) return null;
    const m = new RegExp(`^\\s*${local}\\s*=\\s*((?:[A-Z][\\w:]*|@?[a-z_]\\w*)(?:\\.[a-z_]\\w*[?!]?)+)\\s*(?:\\(|$|\\s+(?:if|unless)\\b)`).exec(code);
    if (!m) continue;
    // Narrowed from itself (`scope = scope.includes(…)`): what it held before, narrowed.
    if (m[1]!.startsWith(`${local}.`)) {
      const earlier = localChainBefore(lines, j, local);
      return earlier ? earlier + m[1]!.slice(local.length) : null;
    }
    return m[1]!;
  }
  return null;
}

/**
 * `@clubs = Current.league.clubs` in a controller: the relation an action hands
 * its view, which runs the query when it renders. Read as `….clubs.all` so the
 * association join names the model; a chain no association settles is dropped there.
 */
const RELATION_ASSIGN_RE = /^\s*@[a-z_]\w*\s*(?:\|\|)?=\s*((?:Current|@?[a-z_]\w*|[A-Z]\w*(?:::[A-Z]\w*)*)(?:\.[a-z_]\w*)*\.[a-z_]\w*s)\s*$/;

function extractRubyDataSources(lines: string[], classes: readonly ClassInfo[] = []): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const seen = new Set<string>();
  const controllers = classes.filter((c) => /Controller$/.test(c.name));
  const inController = (line: number): boolean => controllers.some((c) => line >= c.line && line <= c.endLine);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // A chain whose receiver stands on its own line (`Match` / `  .where(…)`):
    // read the first continued call as part of this line.
    const next = (lines[i + 1] ?? "").trimStart();
    if (next.startsWith(".") && /[\w)]\s*$/.test(line.replace(/\s+#.*$/, ""))) line = line.trimEnd() + next;
    for (const m of line.matchAll(AR_CALL_RE)) {
      const receiver = m[1]!;
      const method = m[2]!;
      const bare = receiver.split("::").pop()!;
      if (NON_MODEL_CONSTANTS.has(bare)) continue;
      if (!isArQueryMethod(method)) continue;
      const name = `${receiver}.${method}`;
      const key = `${name}@${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "database", name, target: null, calls: [], line: i + 1, entity: bare, access: arAccessKind(method) });
    }
    // Association and instance chains: `Current.account.conversations.find_by!(…)`,
    // `@conversation.messages.create!(…)`, `conversation.update!(…)`. Which
    // model that is lives in another file (the association's declaration, the
    // model named like the variable), so the row goes out entity-less and
    // `RubyEntityExtractor.reconcileProject` joins or drops it. A bare
    // lowercase receiver counts only with a WRITE verb — `items.first` is an
    // Array; `contact.save!` is persistence.
    const relation = RELATION_ASSIGN_RE.exec(line.replace(/\s+#.*$/, ""));
    if (relation && !/^(?:params|request|session)\b/.test(relation[1]!) && inController(i + 1)) {
      out.push({ kind: "database", name: `${relation[1]}.all`, target: null, calls: [], line: i + 1, access: "read" });
      continue;
    }
    if (!AR_VERB_GATE.test(line)) continue; // the chain regex is costly; most lines call no AR verb
    for (const m of line.matchAll(AR_CHAIN_RE)) {
      const receiver = m[1]!;
      const method = m[2]!;
      // `@message.save!` — an instance write is no query method, but persists.
      if (!isArQueryMethod(method) && !AR_WRITE_METHODS.has(method)) continue;
      const chained = receiver.includes(".");
      // A local holding a relation (`scope = Current.account.contacts` … `scope.find(id)`):
      // the row names the chain it was assigned, which the association join resolves.
      if (!chained && !AR_WRITE_METHODS.has(method)) {
        const rhs = /^[a-z_]\w*$/.test(receiver) ? localChainBefore(lines, i, receiver) : null;
        if (!rhs) continue;
        const name = `${rhs}.${method}`;
        const key = `${name}@${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "database", name, target: null, calls: [], line: i + 1, access: arAccessKind(method) });
        continue;
      }
      if (/^[A-Z]/.test(receiver) && !chained) continue; // `Model.verb` — the row above
      const name = `${receiver}.${method}`;
      const key = `${name}@${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "database", name, target: null, calls: [], line: i + 1, access: arAccessKind(method) });
    }
  }
  return out;
}

export const rubySpec: RegexLangSpec = {
  language: "ruby",
  extensions: [".rb", ".rake", ".jbuilder"],
  indentBased: true,
  // Blocks end at their `end`, read by keyword — not where the indentation drops (see blocks.ts).
  blockEnds: rubyBlockEndsOf,
  // Calls are read from code only: heredoc SQL / JS / prompts and `%w[]` words name no method.
  callSourceLines: rubyCodeLinesOf,
  // A Rake file's tasks, a Jbuilder view's statements and a script's body
  // (`script/`, `db/seeds.rb`, `db/seeds/`) are the file's own: their calls
  // are its `<setup>`.
  topLevelCalls: /\.(?:rake|jbuilder)$|(?:^|\/)script\/.+\.rb$|(?:^|\/)db\/seeds(?:\.rb$|\/.+\.rb$)/,
  topLevelCallsInTypelessFiles: true,
  // Specs and tests are read by their runners; `config/` is read by the framework (`config.ru`, at the root, is no `config/` file and keeps its setup).
  typelessSetupExcluded: /(?:^|\/)(?:spec|test)\/|_(?:spec|test)\.rb$/,
  lineCommentPrefixes: ["#"],

  inlineBodyColumn: rubyInlineBodyColumn,

  functionPatterns: [
    {
      // `def name`, `def self.name`, `def Const.name`, after a visibility call
      // (`private def x`, `private_class_method def x`); a setter keeps its `=`
      // (`def value=(v)` is not the reader `value`), an operator method its
      // operator (`def <=>(other)`, `def [](key)`).
      pattern: /^\s*(?:(?:private|protected|public|private_class_method|public_class_method|module_function)\s+)?def\s+(?:(?:self|[A-Z]\w*)\.)?([a-zA-Z_]\w*(?:[?!]|=(?=\s*\())?|<=>|===?|=~|!=|!~|\[\]=?|[-+]@|\*\*|<<|>>|<=|>=|[-+*\/%<>&|^~!])/,
      isExported: (_l, name) => !name.startsWith("_"),
      keywordNames: true,
    },
  ],

  // Ruby: `ClassName.method()`, plus the receiver-typed shapes of di.ts
  // (`UserRepo.new.find`, `AppContainer[:repo].find`, `self.repo.find`).
  //
  // Parentheses are optional in Ruby, so the shared `name(` baseline misses
  // most real call sites (`user.save`, `User.all`, `record.valid?`). A blanket
  // `recv.method` rule would fix that and drown the graph: an attribute read
  // and a zero-arity call are the SAME syntax, so `order.total` would become a
  // call edge to every project method named `total`. The three rules below are
  // the paren-less shapes that carry their own evidence of being calls.
  callPatterns: [
    ...RUBY_DI_CALL_PATTERNS,
    ...RAILS_RENDER_CALL_PATTERNS,
    {
      // A call through a path of readers — `club.league.relegate(`, `@club.league.relegate(`,
      // `self.club.league.relegate(` — is named by every name, so the linker types the receiver from its
      // head: the baseline names the last two (`league.relegate`), which would type it by whatever `league`
      // is in the caller. `self.repo.find(` is the reader pattern's (`repo.find`).
      pattern: /(?<![\w.@$:])@?(?!self\.\w+&?\.\w+[?!]?\s*\()((?:self\.)?[a-z_]\w*(?:&?\.[a-z_]\w*){1,6})&?\.([a-z_]\w*[?!]?)\s*\(/,
      buildName: (m) => ({ name: `${m[1]!.replace(/&\./g, ".")}.${m[2]}`, leafName: m[2] }),
    },
    {
      // Never the tail of a constant path: `League::Club.find(` is `League::Club.find` (below), not `Club.find`.
      pattern: /(?<![\w:])([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      // Predicate / bang methods — `user.valid?`, `record.save!`. `?` and `!`
      // are legal only in a method name, never in an attribute accessor
      // generated by `attr_reader`, so these are unambiguous. The lookbehind
      // drops receivers that are themselves a call result
      // (`u.name.downcase.include?`), where the receiver token names nothing
      // the linker could resolve.
      pattern: /(?<![\w.@$:])[@$]?(\w+)\.(\w+[?!])(?!=)/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      // The same through a path of readers — `club.league.relegated?`, `@club&.league&.reset!` — named by every
      // name, as the parenthesized call is (`club.league.relegate(`), so the linker types the receiver from its
      // head. `self.club.relegated?` calls the reader `club`, as `self.club.relegate(` does.
      pattern: /(?<![\w.@$:])@?((?:self\.)?[a-z_]\w*(?:&?\.[a-z_]\w*){1,6})&?\.([a-z_]\w*[?!])(?!=)/,
      buildName: (m) => ({ name: `${rubyPathReceiver(m[1]!)}.${m[2]}`, leafName: m[2] }),
    },
    {
      // Constant receiver without parens — `User.all`, `Order::Item.recent`.
      // A capitalised receiver is a class or module, so the member is a class
      // method, not a field. The parenthesised spelling is covered above; the
      // dedup in `extractCallsFromBody` collapses the overlap. `Time.now` and
      // `Rails.logger` are suppressed by the same denylist the data-source
      // pass uses — without parens there is nothing else to tell a stdlib
      // constant from a model.
      pattern: PARENLESS_CONST_CALL_RE,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      // A predicate or bang method called with parens and no receiver —
      // `merge_contacts?(a, b)`, `update!(status: :won)`. The baseline `name(`
      // matcher stops at the `?` / `!`, so these were never recorded.
      pattern: /(?<![\w.@$:])(?!defined\?)([a-z_]\w*[?!])\(/,
      buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
    },
    {
      // A chain of calls off a class — `Club.where(active: true).first.full_name`,
      // `Club.find(id).promote!` — named with every step but the last called
      // (`Club.where().first().full_name`), so the linker types it step by step
      // through what each returns. Stdlib and framework constants are no such chain;
      // a construction's (`Club.new(…).x`) is read with its type above.
      pattern: new RegExp(
        String.raw`(?<![\w.@$:])(?:::)?(?!(?:${[...NON_MODEL_CONSTANTS].join("|")})\b)([A-Z]\w*(?:::[A-Z]\w*)*)(?!\.new\b)((?:\.[a-z_]\w*[?!]?(?:\s*\([^()]*\))?){1,4})\.([a-z_]\w*[?!]?)(?![\w?!])(?=\s*(?:\(|$|#|[,)\]}]|\b(?:if|unless|do)\b|\{))`,
      ),
      buildName: (m) => ({ name: `${m[1]}${m[2]!.replace(/\.([a-z_]\w*[?!]?)(?:\s*\([^()]*\))?/g, ".$1()")}.${m[3]}`, leafName: m[3] }),
    },
    {
      // A command call on a local — `club.promote 1`, `club&.relegate :season`: the receiver and
      // method are followed by an argument that starts a value (a number, string, symbol, ivar or
      // name), which an attribute read never is. A keyword after it (`club.name if x`) is no argument.
      pattern: new RegExp(
        String.raw`(?<![\w.@$:])([a-z_]\w*)&?\.([a-z_]\w*[?!]?)[ \t]+(?=${RUBY_COMMAND_ARGUMENT})`,
      ),
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      // The same through a path of readers — `club.league.promote 1`, `@club.league.promote :top` — named by
      // every name, as the parenthesized call is. An attribute read along the path (`club.league`) is no call:
      // only the step an argument follows is recorded.
      pattern: new RegExp(
        String.raw`(?<![\w.@$:])@?((?:self\.)?[a-z_]\w*(?:&?\.[a-z_]\w*){1,6})&?\.([a-z_]\w*[?!]?)[ \t]+(?=${RUBY_COMMAND_ARGUMENT})`,
      ),
      buildName: (m) => ({ name: `${rubyPathReceiver(m[1]!)}.${m[2]}`, leafName: m[2] }),
    },
    {
      // A whole statement that is just `receiver.method` — `user.save`,
      // `todo.destroy`. Reading an attribute and discarding it does nothing,
      // so a bare `x.y` in statement position is a call for its side effect.
      pattern: /^\s*[@$]?(\w+)\.([a-z_]\w*)\s*$/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  classPatterns: [
    {
      // Capture the FULL (possibly namespaced) class name — `League::MatchReport`,
      // not just the first segment `League` (which collided with a `League` concern).
      // A leading `::` (`class ::League::Report`) names the top level; the name is the same.
      pattern: /^\s*class\s+(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/,
      getExtends: (line) => {
        // Superclass may be namespaced too (`< ActiveRecord::Base`, `< League::Base`, `< ::Base`).
        const m = line.match(/<\s*(?:::)?([A-Z][\w:]*)/);
        return m?.[1] ?? null;
      },
    },
    { pattern: /^\s*module\s+(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/, getExtends: () => null },
    {
      // `Striker = Class.new(Base) do … end` / `Striker = Class.new(Base) { … }` — an anonymous class a constant
      // names: a class of that name extending `Base`, whose block's `def`s are its methods. The block's `end` or
      // `}` closes the class (`blockEnds`); a class nobody names is no class here.
      pattern: /^\s*(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)\s*=\s*Class\.new\(\s*(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*\s*\)\s*(?:do\b|\{)/,
      getExtends: (line) => /Class\.new\(\s*(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/.exec(line)?.[1] ?? null,
    },
  ],

  /**
   * Wrap the generic class extractor to attach module mixins
   * (`include`/`extend`/`prepend`) as `implements` edges. Ruby's mixin model
   * is closer to interface-implementation than inheritance, so this maps
   * naturally onto the existing field.
   */
  extractClasses: (lines: string[], fns: FunctionInfo[]) => {
    const classes = extractClassesWithSpec(lines, rubySpec);
    if (classes.length === 0) return classes;
    // A concern's `class_methods do` block is the `ClassMethods` module its includers are extended with.
    addConcernClassMethods(lines, classes);

    for (const cls of classes) {
      addScopeMethods(lines, cls);
      addMacroMembers(lines, cls, classes);
      separateSingletonMethods(lines, cls);
      typeBareConstructions(lines, cls);
      for (const m of cls.methods) {
        addParenlessParams(lines, m);
        applyDeclaredParamTypes(lines, m);
        dropDetachedMemberCalls(lines, m);
      }
      // What the class holds: dry-auto_inject readers (by container key) and
      // instance variables typed by what they are assigned.
      const properties = autoInjectProperties(lines, cls, classes);
      const injected = new Set(properties.map((p) => p.name));
      for (const p of collectIvarProperties(lines, cls, classes)) if (!injected.has(p.name)) properties.push(p);
      cls.properties.push(...properties);
      // `agents.find(id)` with no local `agents` calls the method `agents` first.
      // Read from code only: a word in a heredoc or `%w[]` is no call.
      const code = rubyCodeLinesOf(lines);
      const associations = associationNames(lines, cls);
      // The method's locals, read once for the passes that tell a local from a call.
      const boundOf = new Map(cls.methods.map((m) => [m, boundLocals(code, m)]));
      // A memoizing reader (`def club; @club ||= Club.find(…); end`) returns what it assigns.
      for (const m of cls.methods) {
        const memo = memoizedReturn(lines, m, boundOf.get(m)!);
        if (memo) m.returnedFrom = [memo];
      }
      const readers = new Set(cls.methods.filter((m) => m.returnedFrom && !m.classLevel).map((m) => m.name));
      // A controller's or a module's (a concern's) methods may be `before_action` filters.
      const mayFilter = /Controller$/.test(cls.name) || /^\s*module\b/.test(lines[cls.line - 1] ?? "");
      for (const m of cls.methods) {
        const bound = boundOf.get(m)!;
        addOwnClassCalls(lines, cls, m);
        addImplicitReceiverCalls(code, m, bound);
        // `@club = Club.find(…)` types `@club.update_honours` in the method.
        const fields = assignedFieldTypes(lines, m, bound, mayFilter);
        if (fields.length > 0) (m.localTypes ??= []).push(...fields);
        addReaderHeads(code, m, readers, bound);
        addAnonymousClassCalls(code, m);
        const elements = addBlockParamTypes(code, m, associations, bound);
        addTypedLocalCalls(code, m, elements);
        addMemberChainCalls(code, m, associations, bound);
        addJobDispatchCalls(lines, m);
        addOwnMethodCalls(code, cls, m, bound);
        addSymbolListDispatchCalls(lines, code, cls, m);
        addBareStatementCalls(code, cls, m, bound);
        addSuperCalls(code, m);
      }
      // A controller's filters, for the project pass that runs them before each action.
      if (/Controller$/.test(cls.name)) cls.decorators.push(...filterDecorators(lines, cls));
      // What each instance variable is assigned from a call chain (`@agent = agents.find(id)`,
      // `@conversation ||= Current.account.conversations.find_by!(…)`): the entity pass types
      // `@agent.update!` through it (RubyEntityExtractor.reconcileProject).
      const ivarChains = ivarAssignedChains(lines, cls);
      if (Object.keys(ivarChains).length > 0) cls.fieldValues = { ...(cls.fieldValues ?? {}), ...ivarChains };

      // Scan the class body for include/extend/prepend statements.
      // Each one names a module that ought to count as a relationship for
      // the data-model graph. Lines outside the class's body range are
      // ignored, so module mixins from sibling classes don't bleed — and so
      // are the lines of a class or module nested inside it, whose mixins are
      // its own (`include Scoring` in `module League; class Club` is Club's).
      const seen = new Set<string>(cls.implements ?? []);
      const nested = classes.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
      const mixins: NonNullable<ClassInfo["mixins"]> = [];
      for (let i = cls.line; i < cls.endLine && i < lines.length; i++) {
        if (nested.some((c) => i + 1 >= c.line && i + 1 <= c.endLine)) continue;
        const line = lines[i] ?? "";
        // `include Import["repo"]` builds readers — it is no module the class implements.
        if (isAutoInjectInclude(line)) continue;
        // include Foo, Bar    /   extend Foo    /   prepend Foo
        const mixinMatch = line.match(/^\s*(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/);
        if (!mixinMatch) continue;
        const kind = mixinMatch[1] as "include" | "extend" | "prepend";
        for (const name of mixinMatch[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!mixins.some((m) => m.name === name && m.kind === kind)) mixins.push({ name, kind });
          if (!seen.has(name)) {
            seen.add(name);
            cls.implements.push(name);
          }
        }
      }
      if (mixins.length > 0) cls.mixins = mixins;
    }
    // Strong params live in a private `user_params` helper the action calls;
    // copy that access onto the action so the route join sees it there.
    propagateHelperAccess(lines, classes);
    // Suppress the now-duplicated methods from the top-level functions list,
    // mirroring what regex-extractor.ts does for any spec providing
    // extractClasses.
    return classes;
  },

  /**
   * What a method body reads from the request — Rails `params`/`request`
   * idioms (see `route-meta.ts`). Lands on `FunctionInfo.requestAccess`; the
   * convention routes below and the project-level handler join both consume it.
   */
  extractRequestAccess: (bodyLines) => extractRubyRequestAccess(bodyLines),
  extractResponses: (bodyLines) => extractRubyResponses(bodyLines),

  // `def initialize(repo: UserRepo.new)` — a constructing default types the
  // parameter (see di.ts for YARD / Sorbet declarations).
  parseParam: parseRubyParam,

  // `SERVICE = ClubService.new` at the top level: the constant's type, for `SERVICE.process`.
  extractModuleBindings: (lines) => rubyModuleBindings(lines),

  // `repo = UserRepo.new`, `repo = AppContainer[:user_repo]`.
  extractLocalTypes: (bodyLines, fn) => extractRubyLocalTypes(bodyLines, fn),

  // dry-container `register(:user_repo) { SqlUserRepo.new }`.
  extractDiBindings: (lines) => extractRubyDiBindings(lines),
  extractHttpClientRegistrations: (lines) => extractRubyHttpClientRegistrations(lines),
  // Scheduled jobs: entry points a clock runs.
  extractEntryPoints: (lines) => extractRubyScheduledJobs(lines),

  // Top-level `def`s get the same declared types and call clean-up as methods.
  postProcessFunctions: (lines, found) => {
    // RSpec's groups, examples and hooks: the functions a spec file has.
    const fns = rspecFunctions(lines, found, rubySpec.callPatterns ?? []);
    for (const fn of fns) {
      addParenlessParams(lines, fn);
      applyDeclaredParamTypes(lines, fn);
      dropDetachedMemberCalls(lines, fn);
    }
    addTypedCallsOverFunctions(lines, fns);
    withRubyArgOrigins(lines, fns);
    return fns;
  },

  extractDataSources: (lines, classes) => {
    const rows = [...extractRubyDataSources(lines, classes), ...extractRubyHttpCalls(lines), ...extractRubyTestRequests(lines), ...extractJobQueueSources(lines, classes), ...extractModelSelfQueries(lines, classes)];
    // The columns an ActiveRecord statement filters on with a request value or a parameter.
    addRubyWhereFields(lines, rows, classes);
    return rows;
  },
  // Where each call's arguments come from (a request value, a parameter), for `paramColumns`.
  postProcessClasses: (lines, classes) => {
    withRubyArgOriginsInClasses(lines, classes);
    return classes;
  },

  importPatterns: [
    {
      pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
    },
    {
      // `autoload :Club, "league/club"` loads that file the first time `Club` is named.
      pattern: /^\s*autoload\s*\(?\s*:(\w+)\s*,\s*['"]([^'"]+)['"]/,
      getSource: (m) => m[2],
      getSpecifiers: (m) => [m[1]],
    },
    {
      // Rails autoload: `ActiveAdmin.register UserRole` administers (and thus
      // depends on) the `UserRole` model — there's no `require`, the constant
      // reference autoloads app/models/user_role.rb. Surfacing it as an import
      // lets the dependency graph link the admin file to its model.
      pattern: /^\s*ActiveAdmin\.register\s+([A-Z][\w:]*)/,
      getSource: (m) => railsUnderscore(m[1]),
      getSpecifiers: (m) => [m[1].split("::").pop() ?? m[1]],
    },
    {
      // Rails autoload via inheritance: `class Foo < Bar` loads Bar's file
      // (e.g. a controller's ApplicationController, a model's LeagueModel). The
      // superclass is already captured as an `extends` edge for the data-model
      // graph; emitting it as an import additionally wires the file-level
      // dependency graph the same way `require` would.
      pattern: /^\s*class\s+[A-Z]\w*\s+<\s+([A-Z][\w:]*)/,
      getSource: (m) => railsUnderscore(m[1]),
      getSpecifiers: (m) => [m[1].split("::").pop() ?? m[1]],
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[], _filePath, _functions, routeFacts) => {
    const routes: RouteInfo[] = [];

    // Grape's nested block DSL (see grape.ts); a Rails router's `mount X => '/'` places a Grape root.
    if (isGrapeFile(lines)) routes.push(...extractGrapeRoutes(lines, classes, (start, end) => extractCallsFromBody(lines, start, end, ["#"], rubySpec.callPatterns), routeFacts));
    extractRackMounts(lines, routeFacts);
    extractGemRoutedControllers(lines, routeFacts);
    // A model's `devise :…` modules and the Devise initializer, for the `devise_for` routes (devise-routes.ts).
    extractDeviseFacts(lines, classes, routeFacts);

    // Sinatra's block DSL — gated on the gem being required / subclassed so a
    // `get '/x' do` in a request spec or a Rails router never counts.
    if (isSinatraFile(lines)) routes.push(...extractSinatraRoutes(lines, (start, end) => extractCallsFromBody(lines, start, end, ["#"], rubySpec.callPatterns)));

    // ActiveAdmin DSL. `ActiveAdmin.register Model do … end` mounts the standard
    // admin CRUD routes under `/admin/<pluralized_resource>`; the generated
    // controller is `Admin::<Model>sController`, but its customisations live in
    // THIS file, so the routes are attributed here. `register_page "Title"`
    // mounts a single GET page.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const reg = line.match(/^ActiveAdmin\.register\s+([A-Z][\w:]*)/);
      if (reg) {
        const model = reg[1].split("::").pop() ?? reg[1];
        const resource = railsPluralize(railsUnderscore(model));
        const basePath = "/admin/" + resource;
        // The generated controller is `Admin::<Plural>Controller`. We carry it
        // as the handler for display, but WITHOUT an `#action` suffix: the
        // symbol linker resolves handlers by their leaf name, and the REST
        // action leaves (`index`, `show`, …) collide with every real
        // controller's methods, producing bogus cross-file edges. The bare
        // class name matches no project symbol, so no false link is emitted.
        const controllerClass = "Admin::" + railsCamelize(resource) + "Controller";
        for (const [action, info] of Object.entries(RAILS_ACTION_MAP)) {
          void action;
          routes.push({
            path: basePath + info.suffix,
            httpMethod: info.method,
            kind: "api",
            handler: controllerClass,
            calls: [],
            middleware: [],
            line: i + 1,
          });
        }
        continue;
      }
      const page = line.match(/^ActiveAdmin\.register_page\s+['"]([^'"]+)['"]/);
      if (page) {
        routes.push({
          path: "/admin/" + railsUnderscore(page[1].replace(/\s+/g, "_")),
          httpMethod: "GET",
          kind: "api",
          handler: null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      }
    }

    // Rails routes only public methods: a bare `private`/`protected` hides every
    // method below it (until `public` or the class ends), `private def x` and
    // `private :x, :y` only the ones they name.
    const privateMethodLines = new Set<number>();
    const privateNames = new Set<string>();
    let inPrivateBlock = false;
    let privateBlockIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart().replace(/\s+#.*$/, "");
      const indent = line.length - line.trimStart().length;
      if (/^(?:private|protected)$/.test(trimmed)) {
        inPrivateBlock = true;
        privateBlockIndent = indent;
        continue;
      }
      if (/^(?:private|protected)\s+def\b/.test(trimmed)) {
        privateMethodLines.add(i + 1);
        continue;
      }
      const named = /^(?:private|protected)\s+(:[\w?!]+(?:\s*,\s*:[\w?!]+)*)$/.exec(trimmed);
      if (named) {
        for (const n of named[1]!.matchAll(/:([\w?!]+)/g)) privateNames.add(n[1]!);
        continue;
      }
      if (/^public\b/.test(trimmed)) {
        inPrivateBlock = false;
        continue;
      }
      if (inPrivateBlock && trimmed !== "" && indent < privateBlockIndent) {
        inPrivateBlock = false;
      }
      if (inPrivateBlock) privateMethodLines.add(i + 1);
    }

    // Convention: XxxController classes map methods to REST routes
    for (const cls of classes) {
      const leaf = cls.name.split("::").pop() ?? cls.name;
      const match = leaf.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (leaf === "ApplicationController" || leaf === "ActionController") continue;
      // A MODULE named like a controller (`module Premium::Api::ClubsController`, prepended
      // into the real controller at boot) is no controller: Rails routes classes only.
      if (/^\s*module\b/.test(lines[cls.line - 1] ?? "")) continue;

      const modules = enclosingModules(cls, classes);
      const className = [...modules, leaf].join("::");
      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = modules.map((m) => "/" + railsUnderscore(m)).join("") + "/" + resource;

      for (const method of cls.methods) {
        if (privateMethodLines.has(method.line) || privateNames.has(method.name)) continue;
        // A singleton method (`self.x`, see di.ts) is no action.
        if (method.name.startsWith("self.")) continue;
        if (method.name.endsWith("?") || method.name.endsWith("!")) continue;
        if (method.name.startsWith("_")) continue;

        const action = RAILS_ACTION_MAP[method.name];
        const route: RouteInfo = action
          ? {
              path: basePath + action.suffix,
              httpMethod: action.method,
              kind: "api",
              handler: `${className}#${method.name}`,
              calls: method.calls,
              middleware: [],
              line: method.line,
            }
          : {
              path: basePath + "/" + method.name,
              httpMethod: "GET",
              kind: "api",
              handler: `${className}#${method.name}`,
              calls: method.calls,
              middleware: [],
              line: method.line,
            };
        // Filters (`before_action`, `skip_before_action`, CanCan/Pundit
        // macros) and the body's `params` reads → auth / middleware / params.
        applyControllerMeta(lines, cls, method, route);
        routes.push(route);
      }
    }

    // config/routes.rb: resolve paths through namespace/scope nesting, extract
    // the `controller#action` handler so routes link to their controller code,
    // and expand multi-resource / multi-line `resources` declarations.
    //
    // `blockStack` carries one entry per `end`-terminated block (namespace/scope
    // contribute a path prefix; every other block — `if`, `do`, nested
    // `resources do` — contributes ""), so `end` always pops exactly one frame.
    // An entry is absolute when the block resets the path rather than extending
    // it: `collection do` serves the resource's own path, `member do` one member's.
    const blockStack: { prefix: string; absolute?: boolean }[] = [];
    const currentPrefix = (): string => {
      let out = "";
      for (const b of blockStack) out = b.absolute ? b.prefix : out + b.prefix;
      return out;
    };
    // Parallel to `blockStack`: the Devise `authenticate :user do … end` guard a
    // block contributes (null for every other block), inherited by the routes
    // declared inside it.
    const guardStack: (GuardAttr | null)[] = [];
    const currentGuards = (): GuardAttr[] => guardStack.filter((g): g is GuardAttr => g !== null);
    // Parallel to `blockStack`: the module a `namespace :x` block puts its
    // controllers in (`Staff::`), so the handler names the class the file
    // defines. A `scope '/x'` changes the path only, so it contributes nothing.
    const moduleStack: (string | null)[] = [];
    const currentModules = (): string[] => moduleStack.filter((m): m is string => m !== null);
    // Parallel to `blockStack`: the `resources :x do … end` block a route is
    // declared in, for `on: :collection` / `on: :member` and the implicit
    // controller of a bare `get 'presence'` inside it.
    interface ResourceFrame { base: string; controllerClass: string; memberPath: string }
    const resourceStack: (ResourceFrame | null)[] = [];
    const innermostResource = (): ResourceFrame | null => {
      for (let k = resourceStack.length - 1; k >= 0; k--) if (resourceStack[k]) return resourceStack[k];
      return null;
    };
    // Parallel to `blockStack`: true for a `collection do` / `member do` block,
    // where a canonical action (`delete :destroy`) is the scope's path itself.
    const scopeStack: boolean[] = [];
    // Parallel to `blockStack`: the prefix a `namespace :admin` block puts on its route names (`admin_`).
    const nameStack: string[] = [];
    const currentNamePrefix = (): string => nameStack.join("");
    let nextNamePrefix = "";
    const pushBlock = (
      prefix: string,
      guard: GuardAttr | null = null,
      module: string | null = null,
      resource: ResourceFrame | null = null,
      absolute = false,
    ): void => {
      blockStack.push(absolute ? { prefix, absolute } : { prefix });
      nameStack.push(nextNamePrefix);
      nextNamePrefix = "";
      scopeStack.push(absolute);
      guardStack.push(guard);
      moduleStack.push(module);
      resourceStack.push(resource);
    };
    const popBlock = (): void => {
      blockStack.pop();
      nameStack.pop();
      scopeStack.pop();
      guardStack.pop();
      moduleStack.pop();
      resourceStack.pop();
    };
    const withGuards = (route: RouteInfo): RouteInfo => applyRouteMeta(route, { inheritedGuards: currentGuards() });

    // Only run the routes.rb DSL matchers on an actual router file. Without this
    // gate the verb / `resources` patterns below mis-read any `.rb` that happens
    // to call `get`/`post`/`delete` with a string — RSpec request specs and
    // Cucumber steps (`get "/duties.xml?employee_id=#{id}"`) — flooding the map
    // with bogus routes. A real router opens `…routes.draw do`.
    const isRailsRouter = lines.some((l) => /\.routes\.draw\b/.test(l));

    for (let i = 0; isRailsRouter && i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;

      // `end` closes the most recent block.
      if (/^end\b/.test(line)) {
        popBlock();
        continue;
      }

      const opensDoBlock = /\bdo\b(\s*\|[^|]*\|)?$/.test(line);

      // namespace :x do / scope '/x' do — open a block that prefixes child paths.
      const nsMatch = line.match(/^namespace\s+:(\w+)/);
      if (nsMatch && opensDoBlock) {
        nextNamePrefix = nsMatch[1] + "_";
        pushBlock("/" + nsMatch[1], null, railsCamelize(nsMatch[1]));
        continue;
      }
      // `scope '/x' do`, `scope path: '/x' do`, `scope module: :accounts do` — a
      // path prefix, a controller module (`Accounts::`), or both.
      if (/^scope\b/.test(line) && opensDoBlock) {
        const raw = line.match(/^scope\s+['"]([^'"]+)['"]/)?.[1] ?? line.match(/\bpath:\s*['"]([^'"]+)['"]/)?.[1] ?? "";
        const p = raw ? raw.replace(/^\/?/, "/") : "";
        const module = line.match(/\bmodule:\s*:?['"]?([\w/]+)/)?.[1];
        pushBlock(p === "/" ? "" : p, null, module ? railsModule(module) : null);
        continue;
      }
      // `controller :clubs do … end`: the routes inside are that controller's actions, at the enclosing path.
      const controllerBlock = line.match(/^controller\s+(?::|['"])([\w/]+)['"]?/);
      if (controllerBlock && opensDoBlock) {
        pushBlock("", null, null, { base: currentPrefix(), controllerClass: railsControllerClass(controllerBlock[1]!, currentModules()), memberPath: "" });
        continue;
      }
      // Devise: `authenticate :user do … end` / `authenticated :admin do … end`
      // — every route inside requires that scope to be signed in.
      const deviseMatch = line.match(/^(authenticated?)\s+:(\w+)/);
      if (deviseMatch && opensDoBlock) {
        const text = `${deviseMatch[1]} :${deviseMatch[2]}`;
        pushBlock("", { text, policies: [text], schemes: ["devise"] });
        continue;
      }

      // devise_token_auth: `mount_devise_token_auth_for 'User', at: 'auth', controllers: {…}, skip: […]`
      // draws the gem's documented routes under the mount, each on the controller the mount
      // names for its group, else the gem's own (`DeviseTokenAuth::SessionsController`).
      if (/^mount_devise_token_auth_for\b/.test(line)) {
        let stmt = line;
        const open = (t: string) => (t.match(/[{[(]/g)?.length ?? 0) - (t.match(/[}\])]/g)?.length ?? 0);
        while ((open(stmt) > 0 || /,\s*$/.test(stmt)) && i + 1 < lines.length) stmt += " " + lines[++i]!.trim();
        const at = stmt.match(/\bat:\s*['"]([^'"]*)['"]/)?.[1] ?? "auth";
        const base = currentPrefix() + (at ? "/" + at.replace(/^\/+|\/+$/g, "") : "");
        const named = new Map<string, string>();
        const controllers = stmt.match(/\bcontrollers:\s*\{([^}]*)\}/)?.[1] ?? "";
        for (const m of controllers.matchAll(/(\w+):\s*['"]([\w/]+)['"]/g)) named.set(m[1]!, m[2]!);
        const skip = new Set([...(stmt.match(/\bskip:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/:(\w+)/g)].map((m) => m[1]!));
        for (const r of DEVISE_TOKEN_AUTH_ROUTES) {
          if (skip.has(r.group)) continue;
          const own = named.get(r.group);
          const handler = r.action ? `${own ? railsControllerClass(own, currentModules()) : `DeviseTokenAuth::${railsCamelize(r.group)}Controller`}#${r.action}` : null;
          const row = withGuards({ path: base + r.path || "/", httpMethod: r.method, kind: "api", handler, calls: [], middleware: [], line: i + 1 });
          routes.push(row);
          // The mount names the model (`'User'`): the gem's actions work on it.
          const model = /^mount_devise_token_auth_for\s*\(?\s*['"]([\w:]+)['"]/.exec(line)?.[1];
          const access = r.action ? DEVISE_TOKEN_AUTH_ACCESS[`${r.group}#${r.action}`] : undefined;
          if (routeFacts && model && handler && access) {
            routeFacts.push({ kind: "rails-devise-model", line: i + 1, data: { model: model.replace(/^::/, ""), method: r.method, path: row.path, handler, action: r.action, access } });
          }
        }
        continue;
      }

      // Devise: `devise_for :players, path: 'squad', controllers: {…}, skip: […]` draws the routes of the
      // modules the model's `devise` line enables — another file's fact, joined by `railsDeviseRoutes`.
      if (/^devise_for\b/.test(line)) {
        let stmt = line.replace(/\s#.*$/, "");
        const at = i;
        const open = (t: string) => (t.match(/[{[(]/g)?.length ?? 0) - (t.match(/[}\])]/g)?.length ?? 0);
        while ((open(stmt) > 0 || /,\s*$/.test(stmt)) && i + 1 < lines.length) stmt += " " + lines[++i]!.trim().replace(/\s#.*$/, "");
        const fact = deviseForFact(stmt, at + 1, { prefix: currentPrefix(), namePrefix: currentNamePrefix(), modules: currentModules(), guards: currentGuards() });
        if (fact && routeFacts) routeFacts.push(fact);
        if (/\bdo\b(\s*\|[^|]*\|)?$/.test(stmt)) pushBlock("");
        continue;
      }

      // `collection do … end` / `member do … end` inside `resources :x do`:
      // routes hang off the collection (`/x/search`) or one member (`/x/:id/snooze`),
      // not off the nested `/x/:x_id` prefix the resources block opened.
      const scopeMatch = line.match(/^(collection|member)\s+do\b/);
      if (scopeMatch) {
        const resource = innermostResource();
        if (resource) {
          pushBlock(scopeMatch[1] === "member" ? resource.base + resource.memberPath : resource.base, null, null, null, true);
        } else pushBlock("");
        continue;
      }

      // resources :a, :b, :only => [...] — may span multiple lines (trailing comma).
      // Expand each resource into its full RESTful route set so member paths
      // (`/duties/:id`) exist for cross-tier matching — not just the collection
      // base — honoring the enclosing namespace/scope prefix and any
      // `only:`/`except:` filter. `resource` (singular) drops `index`/`:id`.
      const resourcesMatch = line.match(/^(resources?)\b/);
      if (resourcesMatch) {
        let stmt = line;
        while (/,\s*$/.test(stmt) && i + 1 < lines.length) {
          stmt += " " + lines[++i].trim();
        }
        const singular = resourcesMatch[1] === "resource";
        const actionMap = singular ? SINGULAR_ACTION_MAP : RAILS_ACTION_MAP;
        const { only, except } = parseActionFilter(stmt);
        // Take the leading :symbol list, before any option (only:/except:/=>).
        const beforeOpts = stmt.slice(resourcesMatch[1].length).split(/\b(?:only|except|controller|module|path|as|param)\b|=>/)[0];
        // `param: :inbox_id` renames the member's `:id`.
        const memberParam = stmt.match(/\bparam:\s*:(\w+)/)?.[1] ?? "id";
        // `as: :teams` renames the helpers (`teams_path`, `team_path`, `edit_team_path`).
        const asName = stmt.match(/\bas:\s*(?::(\w+)|['"](\w+)['"])/)?.slice(1).find(Boolean) ?? null;
        // `resources :inboxes, module: :assignment_policies` puts its controller in that module.
        const optionModule = stmt.match(/\bmodule:\s*:?['"]?([\w/]+)/)?.[1];
        // `resources :children, controller: 'children'` names the class explicitly.
        const explicitController = stmt.match(/\bcontroller:\s*(?:['"]([\w/]+)['"]|:(\w+))/)?.slice(1).find(Boolean) ?? null;
        let frame: ResourceFrame | null = null;
        let nestedPrefix = "";
        for (const m of beforeOpts.matchAll(/:(\w+)/g)) {
          const name = m[1]!;
          // Rails maps a singular `resource :session` to the plural SessionsController.
          const controllerClass = railsControllerClass(
            explicitController ?? (singular ? railsPluralize(name) : name),
            optionModule ? [...currentModules(), railsModule(optionModule)] : currentModules(),
          );
          const base = currentPrefix() + "/" + name;
          const memberPath = singular ? "" : "/:" + memberParam;
          frame = { base, controllerClass, memberPath };
          // Routes nested in the block hang off one member: `resources
          // :employees do resources :contact_informations end` serves
          // `/employees/:employee_id/contact_informations`.
          nestedPrefix = singular ? "/" + name : "/" + name + "/:" + railsSingularize(name) + "_id";
          for (const [action, info] of Object.entries(actionMap)) {
            if (only && !only.has(action)) continue;
            if (except.has(action)) continue;
            // Rails routes `update` on PATCH and on PUT alike.
            for (const method of action === "update" ? ["PATCH", info.method] : [info.method]) {
              const helper = asName ? resourceHelper(currentNamePrefix(), asName, action, singular) : null;
              routes.push(withGuards({
                path: base + info.suffix.replace("/:id", memberPath),
                httpMethod: method,
                kind: "api",
                handler: `${controllerClass}#${action}`,
                calls: [],
                middleware: [],
                line: i + 1,
                ...(helper ? { name: helper } : {}),
              }));
            }
          }
        }
        if (opensDoBlock) pushBlock(nestedPrefix, null, null, frame); // `resources :x do` opens a nested block
        continue;
      }

      // `root to: 'dashboard#index'` / `root 'dashboard#index'`: GET on the enclosing prefix.
      const rootMatch = line.match(/^root\b\s*(?:to:\s*|=>\s*)?['"]([^'"#]+)#(\w+)['"]/);
      if (rootMatch) {
        if (!FRAMEWORK_CONTROLLER_RE.test(rootMatch[1]!)) {
          routes.push(withGuards({
            path: currentPrefix() || "/",
            httpMethod: "GET",
            kind: "api",
            handler: `${railsControllerClass(rootMatch[1]!, currentModules())}#${rootMatch[2]}`,
            calls: [],
            middleware: [],
            line: i + 1,
          }));
        }
        continue;
      }

      // get/post/put/patch/delete 'path' [=> 'ctrl#action' | to: 'ctrl#action'],
      // or a symbol inside a resources block: `post :seed, on: :member`,
      // `delete :avatar, on: :member, action: :destroy_avatar`.
      const verbMatch = line.match(/^(get|post|put|patch|delete)\s+(?:['"]([^'"]+)['"]|:(\w+))/);
      if (verbMatch) {
        const rawPath = verbMatch[2] ?? verbMatch[3]!;
        const explicitAction = line.match(/(?:\baction:|:action\s*=>)\s*:?['"]?(\w+)/)?.[1];
        const target = line.match(/(?:=>|to:)\s*['"]([^'"#]+)#(\w+)['"]/);
        // Inside `resources :children do … end`: `on: :collection` hangs off
        // the collection (`/children/presence`), `on: :member` off one member
        // (`/children/:id/presence`), and the handler is that resource's
        // controller unless the line names another.
        // `on: :collection` or the older `:on => :collection`.
        const on = line.match(/(?:\bon:|:on\s*=>)\s*:(collection|member)\b/)?.[1] ?? null;
        const resource = innermostResource();
        let controller: string | null = null;
        let action: string | null = null;
        let handler: string | null = null;
        if (/(?:=>|\bto:)\s*redirect\b/.test(line)) {
          // `get '/old', to: redirect('/new')`: Rails answers it, no controller does.
        } else if (target) {
          controller = target[1];
          action = target[2];
        } else if (explicitAction && resource) {
          // `get 'preview/:token', action: :preview_status` inside a resources block.
          handler = `${resource.controllerClass}#${explicitAction}`;
        } else if (rawPath.includes("/")) {
          // Implicit `controller/action` convention (e.g. `get 'absences/vacation_days'`).
          const segs = rawPath.split("/").filter((s) => s && !s.startsWith(":") && !s.startsWith("*"));
          if (segs.length >= 2) {
            action = segs[segs.length - 1];
            controller = segs.slice(0, -1).join("/");
          }
        } else if (resource) {
          handler = `${resource.controllerClass}#${explicitAction ?? rawPath.replace(/^\//, "")}`;
        }

        // Framework-internal controllers have no project code — skip the route.
        if (controller && FRAMEWORK_CONTROLLER_RE.test(controller)) continue;
        if (controller && action) handler = `${railsControllerClass(controller, currentModules())}#${action}`;

        // In a collection or member scope a canonical action is the scope's own
        // path: `delete :destroy` → `DELETE /inbox_members`, `get :show, on: :member` → `/x/:id`.
        const inScope = (on !== null && resource !== null) || scopeStack[scopeStack.length - 1] === true;
        const relPath =
          inScope && verbMatch[3] && CANONICAL_ACTIONS.has(verbMatch[3]) ? "" : rawPath.startsWith("/") ? rawPath : "/" + rawPath;
        const path =
          on && resource
            ? resource.base + (on === "member" ? resource.memberPath : "") + relPath
            : currentPrefix() + relPath;

        // `as: :league_table` names the helper `league_table_path` (under a namespace, `admin_league_table`).
        const asName = line.match(/(?:\bas:|:as\s*=>)\s*(?::(\w+)|['"](\w+)['"])/)?.slice(1).find(Boolean);
        routes.push(withGuards({
          path,
          httpMethod: verbMatch[1].toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: i + 1,
          ...(asName ? { name: currentNamePrefix() + asName } : {}),
        }));
        continue;
      }

      // Any other `end`-terminated block (if/unless/case/do/...) — track depth
      // so a later `end` doesn't pop a namespace/scope prefix prematurely.
      const opensIfBlock = /^(if|unless|case|begin|while|until|module|class|def)\b/.test(line);
      if (opensDoBlock || opensIfBlock) pushBlock("");
    }

    return routes;
  },
};
