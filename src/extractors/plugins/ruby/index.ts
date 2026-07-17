import type { RouteInfo, ClassInfo, FunctionInfo, DataSourceInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

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
  const onlyM = stmt.match(/(?:\bonly\s*:|:only\s*=>)\s*(\[[^\]]*\]|:\w+)/);
  if (onlyM) only = new Set([...onlyM[1]!.matchAll(/:(\w+)/g)].map((m) => m[1]!));
  const exceptM = stmt.match(/(?:\bexcept\s*:|:except\s*=>)\s*(\[[^\]]*\]|:\w+)/);
  if (exceptM) for (const m of exceptM[1]!.matchAll(/:(\w+)/g)) except.add(m[1]!);
  return { only, except };
}

/**
 * Controllers provided by Rails / its engines, not the application. Routes that
 * point at these (e.g. `get "/rails/mailers" => "rails/mailers#index"`, the
 * dev-only mailer preview) have no project source, so we drop them rather than
 * surface a handler-less "no code" route.
 */
const FRAMEWORK_CONTROLLER_RE = /^(rails|active_admin|action_cable|action_mailbox|active_storage)\b/;

/** `supervision_time_schedules` / `reports/positions` → `SupervisionTimeSchedules` / `Positions` */
function railsCamelize(token: string): string {
  return token
    .split(/[_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** A `controller` token (last segment) → its Rails class name, e.g. `session` → `SessionController`. */
function railsControllerClass(controllerToken: string): string {
  const last = controllerToken.split("/").pop() ?? controllerToken;
  return railsCamelize(last) + "Controller";
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

/** Naive Rails inflector: `user_role` → `user_roles`, `category` → `categories`. */
function railsPluralize(token: string): string {
  if (/[^aeiou]y$/.test(token)) return token.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(token)) return token + "es";
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

/** A (possibly namespaced) capitalised receiver, not preceded by `.`/word char,
 *  followed by a `.method`. Global — a line may hold several queries. */
const AR_CALL_RE = /(?<![\w.@$])([A-Z]\w*(?:::[A-Z]\w*)*)\.([a-z_]\w*[!?]?)/g;

/** A query entry point: an explicit AR method, or any `find…` finder
 *  (`find`, `find_by`, `find_each`, dynamic `find_by_email`, app `find_authorized`). */
function isArQueryMethod(method: string): boolean {
  return AR_QUERY_METHODS.has(method) || /^find($|_)/.test(method);
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

  let arg = line.slice(start, i).trim();
  const lit = arg.match(/^(['"])([\s\S]*)\1$/);
  if (lit) arg = lit[2]!;
  return arg.length > 0 ? arg : null;
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
 * (`url = "#{GRUNDDATA_API_URL}/institution"`), so a single top-to-bottom pass
 * keeps a file-local map of the most recent string-literal assignment per name
 * and resolves a bare-identifier target through it — reproducing `#{…}`
 * interpolations verbatim (as the JS/PHP URL resolvers do) so a concrete
 * endpoint path surfaces instead of the opaque variable name.
 */
function extractRubyHttpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const seen = new Set<string>();
  const varLiterals = new Map<string, string>();
  const push = (verb: string, rawTarget: string | null, line: number, col: number): void => {
    const target =
      rawTarget && BARE_VAR_RE.test(rawTarget) ? varLiterals.get(rawTarget) ?? rawTarget : rawTarget;
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
  }
  return out;
}

/**
 * Surface ActiveRecord access (`Absence.find_authorized(..)`, `Department.where(..)`,
 * `Employee.create!`, namespaced `IstLoen::KmdIndberetning.all`) as `database`
 * data sources, so a controller/service method links to the entity it touches —
 * the backend half of the screen→API→DB chain. Per-file extraction can't see
 * cross-file types, so `entity` is set to the receiver's bare model name (matching
 * how the entity graph indexes its nodes); the shared enricher would otherwise
 * reject a `Ns::Model` receiver as a non-identifier.
 */
function extractRubyDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
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
      out.push({ kind: "database", name, target: null, calls: [], line: i + 1, entity: bare });
    }
  }
  return out;
}

export const rubySpec: RegexLangSpec = {
  language: "ruby",
  extensions: [".rb"],
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      pattern: /^\s*def\s+(?:self\.)?([a-zA-Z_]\w*[?!]?)/,
      isExported: (_l, name) => !name.startsWith("_"),
    },
  ],

  // Ruby: `self.service.method()` and `ClassName.method()`
  callPatterns: [
    {
      pattern: /self\.(\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `self.${m[1]}.${m[2]}`, leafName: m[2] }),
    },
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  classPatterns: [
    {
      // Capture the FULL (possibly namespaced) class name — `IstLoen::KmdIndberetning`,
      // not just the first segment `IstLoen` (which collided with the IstLoen concern).
      pattern: /^\s*class\s+([A-Z]\w*(?:::[A-Z]\w*)*)/,
      getExtends: (line) => {
        // Superclass may be namespaced too (`< ActiveRecord::Base`, `< IstLoen::Base`).
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
      // Scan the class body for include/extend/prepend statements.
      // Each one names a module that ought to count as a relationship for
      // the data-model graph. Lines outside the class's body range are
      // ignored, so module mixins from sibling classes don't bleed.
      const seen = new Set<string>(cls.implements ?? []);
      for (let i = cls.line; i < cls.endLine && i < lines.length; i++) {
        const line = lines[i] ?? "";
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
    // Suppress the now-duplicated methods from the top-level functions list,
    // mirroring what regex-extractor.ts does for any spec providing
    // extractClasses.
    return classes;
  },

  extractDataSources: (lines) => [...extractRubyDataSources(lines), ...extractRubyHttpCalls(lines)],

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
      const match = cls.name.match(/^(\w+?)Controller$/);
      if (!match) continue;
      if (cls.name === "ApplicationController" || cls.name === "ActionController") continue;

      const resource = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const basePath = "/" + resource;

      for (const method of cls.methods) {
        if (privateMethodLines.has(method.line)) continue;
        if (method.name.endsWith("?") || method.name.endsWith("!")) continue;
        if (method.name.startsWith("_")) continue;

        const action = RAILS_ACTION_MAP[method.name];
        if (action) {
          routes.push({
            path: basePath + action.suffix,
            httpMethod: action.method,
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        } else {
          routes.push({
            path: basePath + "/" + method.name,
            httpMethod: "GET",
            kind: "api",
            handler: `${cls.name}#${method.name}`,
            calls: method.calls,
            middleware: [],
            line: method.line,
          });
        }
      }
    }

    // config/routes.rb: resolve paths through namespace/scope nesting, extract
    // the `controller#action` handler so routes link to their controller code,
    // and expand multi-resource / multi-line `resources` declarations.
    //
    // `blockStack` carries one entry per `end`-terminated block (namespace/scope
    // contribute a path prefix; every other block — `if`, `do`, nested
    // `resources do` — contributes ""), so `end` always pops exactly one frame.
    const blockStack: string[] = [];
    const currentPrefix = () => blockStack.join("");

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
        blockStack.pop();
        continue;
      }

      const opensDoBlock = /\bdo\b(\s*\|[^|]*\|)?$/.test(line);

      // namespace :x do / scope '/x' do — open a block that prefixes child paths.
      const nsMatch = line.match(/^namespace\s+:(\w+)/);
      if (nsMatch && opensDoBlock) {
        blockStack.push("/" + nsMatch[1]);
        continue;
      }
      const scopeMatch = line.match(/^scope\s+['"]([^'"]+)['"]/);
      if (scopeMatch && opensDoBlock) {
        const p = scopeMatch[1].replace(/^\/?/, "/");
        blockStack.push(p === "/" ? "" : p);
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
        const beforeOpts = stmt.slice(resourcesMatch[1].length).split(/\b(?:only|except)\b|=>/)[0];
        for (const m of beforeOpts.matchAll(/:(\w+)/g)) {
          const name = m[1]!;
          // Rails maps a singular `resource :session` to the plural SessionsController.
          const controllerClass = railsControllerClass(singular ? railsPluralize(name) : name);
          const base = currentPrefix() + "/" + name;
          for (const [action, info] of Object.entries(actionMap)) {
            if (only && !only.has(action)) continue;
            if (except.has(action)) continue;
            routes.push({
              path: base + info.suffix,
              httpMethod: info.method,
              kind: "api",
              handler: `${controllerClass}#${action}`,
              calls: [],
              middleware: [],
              line: i + 1,
            });
          }
        }
        if (opensDoBlock) blockStack.push(""); // `resources :x do` opens a nested block
        continue;
      }

      // get/post/put/patch/delete 'path' [=> 'ctrl#action' | to: 'ctrl#action']
      const verbMatch = line.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/);
      if (verbMatch) {
        const rawPath = verbMatch[2];
        const target = line.match(/(?:=>|to:)\s*['"]([^'"#]+)#(\w+)['"]/);
        let controller: string | null = null;
        let action: string | null = null;
        if (target) {
          controller = target[1];
          action = target[2];
        } else if (rawPath.includes("/")) {
          // Implicit `controller/action` convention (e.g. `get 'absences/vacation_days'`).
          const segs = rawPath.split("/").filter((s) => s && !s.startsWith(":") && !s.startsWith("*"));
          if (segs.length >= 2) {
            action = segs[segs.length - 1];
            controller = segs.slice(0, -1).join("/");
          }
        }

        // Framework-internal controllers have no project code — skip the route.
        if (controller && FRAMEWORK_CONTROLLER_RE.test(controller)) continue;

        routes.push({
          path: currentPrefix() + (rawPath.startsWith("/") ? rawPath : "/" + rawPath),
          httpMethod: verbMatch[1].toUpperCase(),
          kind: "api",
          handler: controller && action ? `${railsControllerClass(controller)}#${action}` : null,
          calls: [],
          middleware: [],
          line: i + 1,
        });
        continue;
      }

      // Any other `end`-terminated block (if/unless/case/do/...) — track depth
      // so a later `end` doesn't pop a namespace/scope prefix prematurely.
      const opensIfBlock = /^(if|unless|case|begin|while|until|module|class|def)\b/.test(line);
      if (opensDoBlock || opensIfBlock) blockStack.push("");
    }

    return routes;
  },
};
