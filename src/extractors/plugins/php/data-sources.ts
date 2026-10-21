import type { Node } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

/** A CodeIgniter Query Builder receiver — `$this->db`, including fluent chains. */
const CI_DB_RECEIVER = /\$this\s*->\s*db\b/;

/**
 * Laravel facades that are NOT Eloquent models but share its verb names
 * (`Route::delete('/x')`, `Session::all()`, `View::first(...)`). Static calls
 * on these must never be classified as database access.
 */
const NON_MODEL_FACADES: ReadonlySet<string> = new Set([
  "Route", "Gate", "Event", "Queue", "Bus", "Log", "Mail", "Notification",
  "Session", "Config", "App", "Artisan", "Validator", "Storage", "File",
  "URL", "Response", "Request", "Broadcast", "Password", "Hash", "Crypt",
  "Cookie", "Lang", "View", "Redirect", "Blade", "Auth",
]);

/**
 * CodeIgniter Query Builder verbs whose first string argument names a table.
 * (Refinement verbs — where/select/order_by/group_by/like/limit/… — carry only
 * columns, so they're deliberately excluded.)
 */
const CI_TABLE_VERBS: ReadonlySet<string> = new Set<string>([
  "get", "get_where", "from", "join",
  "insert", "insert_batch", "insert_string", "replace",
  "update", "update_batch", "update_string", "delete",
  "count_all", "count_all_results", "truncate", "empty_table",
]);

/**
 * PHP data sources — HTTP clients, database calls, environment lookups.
 *
 * Coverage:
 *   - HTTP: Guzzle `$client->get(...)`, Symfony/Laravel `Http::get(...)`, curl
 *   - DB:   PDO `$pdo->query(...)`, Eloquent `Model::where(...)`, Laravel `DB::table(...)`
 *   - Env:  `getenv(...)`, `$_ENV[...]`, `env(...)` (Laravel)
 */
/**
 * PDO / Eloquent / CodeIgniter verbs. `query`, `exec` and `prepare` stay
 * unclassified — the SQL string decides, not the method. Builder verbs
 * (`where`, `with`, `join`, `select`) are composition, not access.
 */
const PHP_DB_ACCESS = dbVerbTable(
  [
    "fetchAll", "fetch", "find", "findOrFail", "first", "firstOrFail",
    "get", "all", "paginate", "count",
  ],
  [
    "insert", "update", "delete", "save", "create", "destroy",
    "updateOrCreate", "firstOrCreate", "replace", "truncate",
  ],
);

/** `{ access }` when classified, `{}` otherwise. */
function phpAccess(method: string): { access?: "read" | "write" } {
  const a = dbAccessFor(method, PHP_DB_ACCESS);
  return a ? { access: a } : {};
}

/** PDO verbs whose first string argument is SQL text, not a column. */
const PDO_SQL_VERBS: ReadonlySet<string> = new Set(["query", "exec", "prepare"]);

/** `static::` / `self::` / `parent::` — the enclosing class, resolved project-wide. */
export const RELATIVE_SCOPE_RE = /^(static|self|parent)$/;

/** Eloquent verbs that start or run a query, on a model statically or on a builder/relation instance. */
const ELOQUENT_VERBS = [
  "find", "findOrFail", "where", "create", "update", "updateOrCreate", "upsert", "insert", "destroy", "delete",
  "all", "first", "firstOrCreate", "firstOrFail", "firstWhere", "sole", "paginate", "select", "query", "pluck",
  "count", "exists", "truncate", "cursor", "chunk",
];

/** Instance-call verbs that mark a PDO / Eloquent / generic ORM access. */
const PHP_INSTANCE_VERBS: ReadonlySet<string> = new Set([
  ...PDO_SQL_VERBS, ...ELOQUENT_VERBS,
  "fetchAll", "fetch", "get", "save", "forceDelete", "restore", "increment", "decrement",
]);

/** Eloquent statics: `Model::where(…)`, `Model::create(…)`, `Model::query()`. */
const ELOQUENT_STATIC_VERBS: ReadonlySet<string> = new Set([
  ...ELOQUENT_VERBS,
  "findMany", "whereIn", "whereHas", "whereNull", "whereNotNull", "with", "withCount", "join", "newQuery",
  "orderBy", "latest", "oldest", "has", "doesntHave", "withTrashed", "onlyTrashed",
]);

/**
 * Builder verbs that keep an Eloquent chain going. A call whose parent is a
 * member call with one of these names (or a terminal verb) is an inner link —
 * the chain's one data-source row is emitted at its outermost such call.
 * Project-specific scopes (`->onlyStandard()`) are not known here: a chain
 * `Model::query()->myScope()->get()` still emits at `get`, whose text carries
 * the `Model::query()` root for the project-level join.
 */
const ELOQUENT_CHAIN_VERBS: ReadonlySet<string> = new Set([
  ...PHP_INSTANCE_VERBS, ...ELOQUENT_STATIC_VERBS,
  "orWhere", "whereNotIn", "orWhereIn", "whereBetween", "whereDate", "orWhereHas", "whereDoesntHave",
  "whereRelation", "whereKey", "whereColumn", "orderByDesc", "limit", "take", "skip", "offset", "groupBy",
  "having", "distinct", "leftJoin", "rightJoin", "lockForUpdate", "sharedLock", "when", "unless",
  "inRandomOrder", "reorder", "forPage", "selectRaw", "whereRaw", "orderByRaw", "addSelect", "getQuery",
  "toBase", "withoutGlobalScopes", "withoutGlobalScope",
]);

/**
 * True when a member call further up `node`'s fluent chain is an Eloquent/PDO
 * chain verb — that call emits the chain's row. Unknown links in between
 * (`Model::query()->myScope()->get()`) are stepped over; a chain that ends in
 * no known verb (`Model::all()->map(…)`) leaves the row at `node`.
 */
function continuesEloquentChain(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    const parent = cur.parent;
    if (!parent || parent.type !== "member_call_expression") return false;
    if (parent.childForFieldName("object")?.id !== cur.id) return false;
    const method = parent.childForFieldName("name")?.text ?? "";
    if (ELOQUENT_CHAIN_VERBS.has(method)) return true;
    cur = parent;
  }
}

export class PhpDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["php"];

  /**
   * curl handle → URL, per file: `$ch = curl_init($url)` and
   * `curl_setopt($ch, CURLOPT_URL, $url)` feed it; `curl_exec($ch)` reads it.
   * A curl session is ONE outbound request — emitting every `curl_setopt` /
   * `curl_close` / `curl_errno` as its own api-call drowned real cross-tier
   * calls in noise (photo-booth: 398 of 431 "api calls" were curl/file plumbing).
   */
  private curlUrls = new Map<string, string>();

  override beginFile(): void {
    this.curlUrls = new Map();
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // function_call_expression (env, curl_*, getenv, file_get_contents)
    if (node.type === "function_call_expression") {
      const fnNode = node.childForFieldName("function");
      const fnName = fnNode?.text;
      if (!fnName) return;

      const line = node.startPosition.row + 1;

      if (fnName === "getenv" || fnName === "env") {
        sources.push(this.ds({
          kind: "env",
          name: fnName,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }

      // curl: the session's URL is recorded where it's configured; the ONE
      // api-call is emitted at curl_exec — the actual request.
      if (fnName === "curl_init") {
        const url = this.firstStringArg(node);
        const handle = curlInitHandle(node);
        if (url && handle) this.curlUrls.set(handle, url);
        return;
      }
      if (fnName === "curl_setopt" || fnName === "curl_setopt_array") {
        const handle = this.argText(node, 0);
        const url = fnName === "curl_setopt"
          ? (this.argText(node, 1) === "CURLOPT_URL" ? this.stringArgAt(node, 2) : null)
          : (node.text.match(/CURLOPT_URL\s*=>\s*['"]([^'"]+)['"]/)?.[1] ?? null);
        if (handle && url) this.curlUrls.set(handle, url);
        return;
      }
      if (fnName === "curl_exec") {
        const handle = this.argText(node, 0);
        sources.push(this.ds({
          kind: "api-call",
          name: "curl",
          target: (handle ? this.curlUrls.get(handle) : null) ?? null,
          line,
        }));
        return;
      }
      if (fnName.startsWith("curl_")) return; // close/errno/getinfo/… — session plumbing, not requests

      // file_get_contents doubles as file I/O and a poor man's HTTP client —
      // only a URL-literal argument marks an outbound call.
      if (fnName === "file_get_contents") {
        const target = this.firstStringArg(node);
        if (target && /^https?:\/\//i.test(target)) {
          sources.push(this.ds({ kind: "api-call", name: fnName, target, line }));
        }
        return;
      }
    }

    // member_call_expression — Guzzle, PDO, Eloquent instance calls
    if (node.type === "member_call_expression") {
      const nameNode = node.childForFieldName("name");
      const objNode = node.childForFieldName("object");
      const method = nameNode?.text ?? "";
      const recvText = objNode?.text ?? "";
      const line = node.startPosition.row + 1;
      const callText = `${recvText}->${method}`;

      // php-amqplib (RabbitMQ): $channel->basic_publish($msg, $exchange, $key)
      // / $channel->basic_consume($queue, ...). AMQP-specific names — any
      // receiver is trusted. Note the argument order differs from pika:
      // the message comes first, the exchange second.
      if (method === "basic_publish") {
        const routingKey = this.stringArgAt(node, 2);
        sources.push(this.ds({
          kind: "queue-publish",
          name: "RabbitMQ: basic_publish",
          target: this.stringArgAt(node, 1) ?? this.argText(node, 1),
          ...(routingKey ? { entity: routingKey } : {}),
          line,
        }));
        return;
      }
      if (method === "basic_consume") {
        sources.push(this.ds({
          kind: "queue-consume",
          name: "RabbitMQ: basic_consume",
          target: this.stringArgAt(node, 0) ?? this.argText(node, 0),
          line,
        }));
        return;
      }

      // CodeIgniter Query Builder: `$this->db->get('orders')`,
      // `$this->db->from('orders')`, `$this->db->insert('orders', $d)`, …
      // The table is the first string arg of a *table-carrying* verb; query
      // refinement verbs (where/select/order_by/…) carry only column names, so
      // they are not data sources in their own right. The `$this->db` receiver
      // also matches a fluent chain — `$this->db->select(...)->from('orders')`
      // — because the chain's receiver text still contains `$this->db`. Setting
      // `entity` is what lets `attributeDataAccessToSymbols` keep the access
      // (an entity-less `database` source is dropped), so the model method that
      // runs the query reaches the table in the Call Traces view.
      if (CI_DB_RECEIVER.test(recvText)) {
        if (CI_TABLE_VERBS.has(method)) {
          const table = this.cleanTable(this.firstStringArg(node));
          if (table) {
            sources.push(this.ds({
              kind: "database",
              name: callText,
              target: table,
              entity: table,
              line,
              ...phpAccess(method),
            }));
          }
        }
        return; // every $this->db->… call is owned by this branch
      }

      // Guzzle-style HTTP: $client->get/post/put/patch/delete/request
      if (/Http|Client|Guzzle/i.test(recvText) && /^(get|post|put|patch|delete|request|send)$/i.test(method)) {
        sources.push(this.ds({ kind: "api-call", ...this.httpRequest(node, method, callText), line }));
        return;
      }

      // PDO + Eloquent + generic ORM patterns. One row per fluent chain — the
      // OUTERMOST call, whose verb is the access that actually runs
      // (`$user->accounts()->where(…)->first()` is one read, not a `where`
      // and a `first`); an inner call whose parent continues the chain with
      // another builder/terminal verb is left to that parent. The first string
      // argument is a TABLE only for the SQL-text verbs — a `where('id', …)`
      // argument is a column, and recording it as the target put a datastore
      // called "id" on the Data Access graph. The Eloquent entity is joined
      // project-wide in `PhpEntityExtractor.reconcileProject`, which knows
      // which classes are models and which relation names reach which.
      if (PHP_INSTANCE_VERBS.has(method)) {
        if (continuesEloquentChain(node)) return;
        // `$request->all()`, `$request->query('page')`: the HTTP request's input, not a model.
        if (REQUEST_INPUT_VERBS.has(method) && objNode && isHttpRequest(objNode, node)) return;
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: PDO_SQL_VERBS.has(method) ? (this.firstStringArg(node) ?? null) : null,
          line,
          ...phpAccess(method),
        }));
        return;
      }
    }

    // scoped_call_expression — Laravel facades and Eloquent static calls
    if (node.type === "scoped_call_expression") {
      const scope = node.childForFieldName("scope")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      const line = node.startPosition.row + 1;
      const callText = `${scope}::${name}`;

      if (scope === "Http" && /^(get|post|put|patch|delete|head|options|send|request)$/i.test(name)) {
        sources.push(this.ds({ kind: "api-call", ...this.httpRequest(node, name, callText), line }));
        return;
      }

      if (scope === "DB" || scope === "Schema" || scope === "Cache" || scope === "Redis") {
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: this.firstStringArg(node) ?? null,
          line,
          ...phpAccess(name),
        }));
        return;
      }

      // Eloquent: Model::find / Model::where / Model::create etc. Heuristic —
      // PascalCase scope and a known persistence method. Laravel's non-model
      // facades share these verbs (`Route::delete`, `Session::all`,
      // `View::first`) — veto them so facade plumbing never becomes a phantom
      // database source.
      // A static call that a fluent chain continues (`Model::where(…)->first()`)
      // is the chain's root, not its access: the member row for the terminal
      // verb carries the whole chain text, root included, and is the one row.
      // `static::`/`self::` inside a model class are the model itself —
      // resolved against the enclosing class in `reconcileProject`.
      if (NON_MODEL_FACADES.has(scope)) return;
      const relative = RELATIVE_SCOPE_RE.test(scope);
      if ((/^[A-Z]/.test(scope) || relative) && ELOQUENT_STATIC_VERBS.has(name)) {
        if (continuesEloquentChain(node)) return;
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: relative ? null : scope,
          line,
          ...phpAccess(name),
        }));
      }
    }

    // $_ENV['KEY'] / $_SERVER['KEY']
    if (node.type === "subscript_expression") {
      const obj = node.child(0);
      if (obj && obj.type === "variable_name") {
        const varText = obj.text;
        if (varText === "$_ENV" || varText === "$_SERVER" || varText === "$_GET" || varText === "$_POST") {
          sources.push(this.ds({
            kind: "env",
            name: varText,
            target: this.firstStringChild(node),
            line: node.startPosition.row + 1,
          }));
        }
      }
    }
  }

  /** Pull the first string argument from a call's `arguments` field. */
  /**
   * Name and URL of an HTTP client call. `request('POST', $url)` /
   * `send('POST', $url)` take the verb first — the row is named by that verb
   * (what the route linker reads the method from) and the URL is the second
   * argument; a verb method takes the URL first. A variable URL is a
   * `{$name}` runtime part.
   */
  private httpRequest(node: Node, method: string, callText: string): { name: string; target: string | null } {
    if (/^(request|send)$/i.test(method)) {
      const verb = (this.stringArgAt(node, 0) ?? this.argText(node, 0)?.replace(/^[\w\\]+::/, ""))?.toUpperCase();
      if (verb && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(verb)) return { name: verb, target: this.urlArgAt(node, 1) };
      // `request($requestType, $endpoint)`: the verb is a variable — a
      // wrapper's parameter, which each call site of the wrapper names.
      return { name: callText, target: this.urlArgAt(node, 1) };
    }
    return { name: callText, target: this.urlArgAt(node, 0) };
  }

  /** A URL argument: a string literal, or a variable as its `{$name}` runtime part. */
  private urlArgAt(node: Node, index: number): string | null {
    const literal = this.stringArgAt(node, index);
    if (literal !== null) return literal;
    const arg = node.childForFieldName("arguments")?.children.filter((c) => c.type === "argument")[index];
    const inner = arg?.namedChildren[0];
    return inner?.type === "variable_name" ? `{${inner.text}}` : null;
  }

  private firstStringArg(node: Node): string | null {
    const args = node.childForFieldName("arguments");
    if (!args) return null;
    for (const a of args.children) {
      if (a.type === "argument") {
        for (const inner of a.children) {
          if (inner.type === "string") return inner.text.replace(/^['"]|['"]$/g, "");
          if (inner.type === "encapsed_string") return inner.text.replace(/^"|"$/g, "");
        }
      }
    }
    return null;
  }

  /** Raw source text of the argument at `index` (`$ch`, `CURLOPT_URL`), null if absent. */
  private argText(node: Node, index: number): string | null {
    const args = node.childForFieldName("arguments");
    if (!args) return null;
    let i = 0;
    for (const a of args.children) {
      if (a.type !== "argument") continue;
      if (i === index) {
        const text = a.text.trim().replace(/\s+/g, " ");
        return text && text.length <= 64 ? text : null;
      }
      i++;
    }
    return null;
  }

  /** Unquoted string-literal value of the argument at `index`; null for non-literals. */
  private stringArgAt(node: Node, index: number): string | null {
    const args = node.childForFieldName("arguments");
    if (!args) return null;
    let i = 0;
    for (const a of args.children) {
      if (a.type !== "argument") continue;
      if (i === index) {
        for (const inner of a.children) {
          if (inner.type === "string" || inner.type === "encapsed_string") {
            const v = inner.text.replace(/^['"]|['"]$/g, "");
            return v || null;
          }
        }
        return null;
      }
      i++;
    }
    return null;
  }

  private firstStringChild(node: Node): string | null {
    for (const c of node.children) {
      if (c.type === "string") return c.text.replace(/^['"]|['"]$/g, "");
    }
    return null;
  }

  /**
   * Normalize a CodeIgniter table argument to a bare table name:
   *   `'orders o'` (alias) → `orders`, `'db.orders'` (schema) → `orders`,
   *   `` `orders` `` (quoted identifier) → `orders`. Returns null for anything
   *   that isn't a plain identifier (a sub-select, an expression, a variable).
   */
  private cleanTable(raw: string | null): string | null {
    if (!raw) return null;
    let t = raw.trim();
    t = t.split(/\s+/)[0] ?? ""; // drop a table alias: "orders o"
    t = t.split(".").pop() ?? t; // drop schema/db prefix: "db.orders"
    t = t.replace(/`/g, ""); // strip backtick identifier quoting
    return /^[A-Za-z_]\w*$/.test(t) ? t : null;
  }
}

/** Methods the HTTP request shares with Eloquent/PDO verbs: reads of its input. */
const REQUEST_INPUT_VERBS: ReadonlySet<string> = new Set(["all", "get", "query", "exists"]);

/**
 * Is `obj` the HTTP request — `$this->request`, `request()`, or a parameter of
 * the enclosing function typed as one (`Request $request`, a FormRequest
 * `StoreClubRequest $request`, PSR-7 `ServerRequestInterface $req`) or left
 * untyped under the name `$request`/`$req`? A local assigned anything else
 * (`$request = TransferRequest::find($id)`) is not.
 */
function isHttpRequest(obj: Node, call: Node): boolean {
  if (obj.text === "$this->request" || /^\\?request\(\s*\)$/.test(obj.text)) return true;
  if (obj.type !== "variable_name") return false;
  let fn: Node | null = call.parent;
  while (fn && !/^(?:method_declaration|function_definition|anonymous_function|arrow_function)$/.test(fn.type)) fn = fn.parent;
  for (const p of fn?.childForFieldName("parameters")?.namedChildren ?? []) {
    if (p?.childForFieldName("name")?.text !== obj.text) continue;
    const type = p.childForFieldName("type")?.text.replace(/^\?/, "");
    if (!type) return /^\$(?:request|req)$/.test(obj.text);
    return /(?:^|\\)\w*Request(?:Interface)?$/.test(type);
  }
  return false;
}

/**
 * The variable a `curl_init(...)` result is assigned to (`$ch = curl_init($url)`
 * → "$ch"), so a URL passed to curl_init can be recalled at curl_exec time.
 */
function curlInitHandle(callNode: Node): string | null {
  const parent = callNode.parent;
  if (parent?.type !== "assignment_expression") return null;
  return parent.childForFieldName("left")?.text ?? null;
}
