import { extractRubyScheduledJobs } from "./scheduled-jobs.js";
import { addJobDispatchCalls, extractJobQueueSources } from "./active-job.js";
import { addScopeMethods, extractModelSelfQueries } from "./model-scopes.js";
import type { CallInfo, RouteInfo, ClassInfo, FunctionInfo, DataSourceInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractCallsFromBody, extractClassesWithSpec } from "../shared/regex-base.js";
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
import { extractRubyResponses } from "./responses.js";

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
const IMPLICIT_RECEIVER_SKIP = new Set(["self", "params", "request", "response", "session", "cookies", "flash", "headers", "super", "nil", "true", "false", "logger", "render", "redirect_to", "head", "it", "yield"]);
function addImplicitReceiverCalls(lines: string[], fn: FunctionInfo): void {
  const bound = new Set(fn.params.map((p) => p.name));
  for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) {
    const code = (lines[i] ?? "").replace(/#.*$/, "");
    for (const m of code.matchAll(/(?:^|[^\w.@:])([a-z_]\w*)\s*(?:\|\|)?=(?![=~>])/g)) bound.add(m[1]!);
    for (const m of code.matchAll(/\|([^|]*)\|/g)) for (const n of m[1]!.split(",")) bound.add(n.trim().replace(/^[*&]/, ""));
  }
  const have = new Set(fn.calls.map((c) => c.name));
  const extra: CallInfo[] = [];
  for (const c of fn.calls) {
    const root = /^([a-z_]\w*)\./.exec(c.name)?.[1];
    if (!root || bound.has(root) || IMPLICIT_RECEIVER_SKIP.has(root) || have.has(root)) continue;
    // Call names drop an instance variable's `@` (`@repo&.find` → `repo.find`): that is no method call.
    if (new RegExp(`@${root}\\b`).test(lines[c.line - 1] ?? "")) continue;
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
function addOwnMethodCalls(lines: string[], cls: ClassInfo, fn: FunctionInfo): void {
  const own = new Set(cls.methods.map((m) => m.name).filter((n) => !/^self\./.test(n) && n !== "initialize"));
  if (own.size === 0) return;
  const bound = new Set(fn.params.map((p) => p.name));
  for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) {
    const code = (lines[i] ?? "").replace(/#.*$/, "");
    for (const m of code.matchAll(/(?:^|[^\w.@:])([a-z_]\w*)\s*(?:\|\|)?=(?![=~>])/g)) bound.add(m[1]!);
    for (const m of code.matchAll(/\|([^|]*)\|/g)) for (const n of m[1]!.split(",")) bound.add(n.trim().replace(/^[*&]/, ""));
  }
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) {
    // Strings and comments are no code.
    const code = (lines[i] ?? "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/#.*$/, "");
    for (const m of code.matchAll(/(?<![\w.@$:])([a-z_]\w*[?!]?)(?![\w(:]|\s*(?:\|\|)?=[^=~>])/g)) {
      const name = m[1]!;
      if (!own.has(name) || bound.has(name) || /\bdef\s+$/.test(code.slice(0, m.index))) continue;
      if (have.has(`${name}@${i + 1}`)) continue;
      have.add(`${name}@${i + 1}`);
      fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
    }
  }
}

/**
 * `builder.perform` on a local the method constructed (`builder = PlayerBuilder.new(…)`):
 * a paren-less call the call patterns cannot tell from an attribute read, but
 * the local's stated type makes it a member of that class.
 */
function addTypedLocalCalls(lines: string[], fn: FunctionInfo): void {
  const typed = (fn.localTypes ?? []).filter((l) => l.type);
  if (typed.length === 0) return;
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  const re = new RegExp(`(?<![\\w.@$:])(${typed.map((l) => l.name).join("|")})\\.([a-z_]\\w*[?!]?)(?![\\w(]|\\s*=[^=~>])`, "g");
  for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) {
    const code = (lines[i] ?? "").replace(/\s#.*$/, "");
    for (const m of code.matchAll(re)) {
      const name = `${m[1]}.${m[2]}`;
      if (have.has(`${name}@${i + 1}`)) continue;
      have.add(`${name}@${i + 1}`);
      fn.calls.push({ name, kind: "internal", target: null, line: i + 1 });
    }
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
  `(?<![\\w.@$:])(?!(?:${[...NON_MODEL_CONSTANTS].join("|")})\\b)([A-Z]\\w*(?:::[A-Z]\\w*)*)\\.([a-z_]\\w*(?:[?!](?!=))?)`,
);

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

function extractRubyHttpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const connectionCall = faradayConnectionNames(lines);
  const seen = new Set<string>();
  const varLiterals = new Map<string, string>();
  const push = (verb: string, rawArg: string | null, line: number, col: number): void => {
    const target = urlOfArg(rawArg, varLiterals);
    const key = `${verb}:${target ?? ""}@${line}:${col}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind: "api-call", name: verb, target, calls: [], line });
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
        push(m[2]!, firstArgUrl(line, m.index! + m[0]!.length), i + 1, m.index!);
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
  // A Rake file's tasks and a Jbuilder view's statements are the file's own:
  // their calls are its `<setup>`.
  topLevelCalls: /\.(?:rake|jbuilder)$/,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
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
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      // Predicate / bang methods — `user.valid?`, `record.save!`. `?` and `!`
      // are legal only in a method name, never in an attribute accessor
      // generated by `attr_reader`, so these are unambiguous. The lookbehind
      // drops receivers that are themselves a call result
      // (`u.name.downcase.include?`), where the receiver token names nothing
      // the linker could resolve.
      pattern: /(?<![\w.@$])[@$]?(\w+)\.(\w+[?!])(?!=)/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
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
      pattern: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)/,
      getExtends: (line) => {
        // Superclass may be namespaced too (`< ActiveRecord::Base`, `< League::Base`).
        const m = line.match(/<\s*([A-Z][\w:]*)/);
        return m?.[1] ?? null;
      },
    },
    { pattern: /^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/, getExtends: () => null },
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

    for (const cls of classes) {
      addScopeMethods(lines, cls);
      separateSingletonMethods(lines, cls);
      typeBareConstructions(lines, cls);
      for (const m of cls.methods) {
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
      for (const m of cls.methods) {
        addImplicitReceiverCalls(lines, m);
        addTypedLocalCalls(lines, m);
        addJobDispatchCalls(lines, m);
        addOwnMethodCalls(lines, cls, m);
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
      // ignored, so module mixins from sibling classes don't bleed.
      const seen = new Set<string>(cls.implements ?? []);
      for (let i = cls.line; i < cls.endLine && i < lines.length; i++) {
        const line = lines[i] ?? "";
        // `include Import["repo"]` builds readers — it is no module the class implements.
        if (isAutoInjectInclude(line)) continue;
        // include Foo, Bar    /   extend Foo    /   prepend Foo
        const mixinMatch = line.match(/^\s*(include|extend|prepend)\s+([A-Z][\w:]*(?:\s*,\s*[A-Z][\w:]*)*)/);
        if (!mixinMatch) continue;
        for (const name of mixinMatch[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!seen.has(name)) {
            seen.add(name);
            cls.implements.push(name);
          }
        }
      }
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

  // `repo = UserRepo.new`, `repo = AppContainer[:user_repo]`.
  extractLocalTypes: (bodyLines, fn) => extractRubyLocalTypes(bodyLines, fn),

  // dry-container `register(:user_repo) { SqlUserRepo.new }`.
  extractDiBindings: (lines) => extractRubyDiBindings(lines),
  // Scheduled jobs: entry points a clock runs.
  extractEntryPoints: (lines) => extractRubyScheduledJobs(lines),

  // Top-level `def`s get the same declared types and call clean-up as methods.
  postProcessFunctions: (lines, fns) => {
    for (const fn of fns) {
      applyDeclaredParamTypes(lines, fn);
      dropDetachedMemberCalls(lines, fn);
    }
    return fns;
  },

  extractDataSources: (lines, classes) => [...extractRubyDataSources(lines, classes), ...extractRubyHttpCalls(lines), ...extractJobQueueSources(lines, classes), ...extractModelSelfQueries(lines, classes)],

  importPatterns: [
    {
      pattern: /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => { const parts = m[1].split("/"); return [parts[parts.length - 1]]; },
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
      // (e.g. a controller's ApplicationController, a model's IdaModel). The
      // superclass is already captured as an `extends` edge for the data-model
      // graph; emitting it as an import additionally wires the file-level
      // dependency graph the same way `require` would.
      pattern: /^\s*class\s+[A-Z]\w*\s+<\s+([A-Z][\w:]*)/,
      getSource: (m) => railsUnderscore(m[1]),
      getSpecifiers: (m) => [m[1].split("::").pop() ?? m[1]],
    },
  ],

  extractRoutes: (lines, classes: ClassInfo[]) => {
    const routes: RouteInfo[] = [];

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

    // Scan for `private` keyword to mark lines below it as private
    const privateMethodLines = new Set<number>();
    let inPrivateBlock = false;
    let privateBlockIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (/^private\s*$/.test(trimmed) || /^private\s+/.test(trimmed)) {
        inPrivateBlock = true;
        privateBlockIndent = indent;
        continue;
      }
      if (/^(public|protected)\b/.test(trimmed)) {
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

      const modules = enclosingModules(cls, classes);
      const className = [...modules, leaf].join("::");
      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = modules.map((m) => "/" + railsUnderscore(m)).join("") + "/" + resource;

      for (const method of cls.methods) {
        if (privateMethodLines.has(method.line)) continue;
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
    const pushBlock = (
      prefix: string,
      guard: GuardAttr | null = null,
      module: string | null = null,
      resource: ResourceFrame | null = null,
      absolute = false,
    ): void => {
      blockStack.push(absolute ? { prefix, absolute } : { prefix });
      scopeStack.push(absolute);
      guardStack.push(guard);
      moduleStack.push(module);
      resourceStack.push(resource);
    };
    const popBlock = (): void => {
      blockStack.pop();
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
      // Devise: `authenticate :user do … end` / `authenticated :admin do … end`
      // — every route inside requires that scope to be signed in.
      const deviseMatch = line.match(/^(authenticated?)\s+:(\w+)/);
      if (deviseMatch && opensDoBlock) {
        const text = `${deviseMatch[1]} :${deviseMatch[2]}`;
        pushBlock("", { text, policies: [text], schemes: ["devise"] });
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
        // `resources :inboxes, module: :assignment_policies` puts its controller in that module.
        const optionModule = stmt.match(/\bmodule:\s*:?['"]?([\w/]+)/)?.[1];
        // `resources :children, controller: 'children'` names the class explicitly.
        const explicitController = stmt.match(/\bcontroller:\s*['"]([\w/]+)['"]/)?.[1] ?? null;
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
              routes.push(withGuards({
                path: base + info.suffix.replace("/:id", memberPath),
                httpMethod: method,
                kind: "api",
                handler: `${controllerClass}#${action}`,
                calls: [],
                middleware: [],
                line: i + 1,
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
        if (target) {
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

        routes.push(withGuards({
          path,
          httpMethod: verbMatch[1].toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [],
          line: i + 1,
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
