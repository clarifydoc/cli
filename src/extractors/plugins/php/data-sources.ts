import type { Node } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable, sqlVerbAccess } from "../shared/db-access.js";
import { statementAccesses } from "../shared/sql-string-sources.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

/**
 * A CodeIgniter Query Builder receiver, including fluent chains: `$this->db`
 * in a controller or model, and the `get_instance()` handle a library keeps —
 * `$this->CI->db`, `$CI->db`, `get_instance()->db`.
 */
export const CI_DB_RECEIVER = /^(?:\$this\s*->\s*(?:_?ci\s*->\s*)?|\$_?ci\s*->\s*|get_instance\(\s*\)\s*->\s*)db\b/i;

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
 * True when a member call further up `node`'s fluent chain emits the chain's
 * row — an instance verb (`->get()`, `->first()`, `->update()`). Builder-only
 * links (`->findMany(…)`, `->orderBy(…)`) and unknown ones
 * (`Model::query()->myScope()->get()`) are stepped over; a chain that ends in
 * no emitting verb (`Song::query()->findMany($ids)`, `Model::all()->map(…)`)
 * leaves the row at `node`.
 */
function continuesEloquentChain(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    const parent = cur.parent;
    if (!parent || parent.type !== "member_call_expression") return false;
    if (parent.childForFieldName("object")?.id !== cur.id) return false;
    const method = parent.childForFieldName("name")?.text ?? "";
    if (PHP_INSTANCE_VERBS.has(method)) return true;
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
  /** String constants the file defines: `define('API_URL', "https://…")`, `const API_URL = '…'`. */
  private constants = new Map<string, string>();
  /**
   * The file declares a namespace or imports one. An Eloquent model is only
   * reachable that way, so a verb-sharing call in a file that does neither
   * (`$this->input->get('page')`, `$writer->save($path)` in CodeIgniter or
   * plain PHP) is no model access — unless its receiver is a PDO handle.
   */
  private namespaced = false;

  override beginFile(_tree: unknown, sourceText: string): void {
    this.curlUrls = new Map();
    this.constants = new Map();
    this.namespaced = /^\s*(?:namespace\s+[\w\\]+|use\s+\\?[A-Z][\w\\]*)/m.test(sourceText);
    if (!sourceText.includes("define") && !sourceText.includes("const")) return;
    for (const m of sourceText.matchAll(/^[ \t]*(?:define\(\s*(['"])(\w+)\1\s*,|(?:(?:public|protected|private)\s+)?const\s+(\w+)\s*=)\s*(['"])([^'"\n]*)\4/gm)) {
      const name = (m[2] ?? m[3])!;
      // The first definition wins, as PHP's does (a later `define` of one name is a warning).
      if (!this.constants.has(name)) this.constants.set(name, m[5]!);
    }
  }

  /**
   * A URL argument as an expression: literals and the file's constants as
   * written, variables as `{$name}` runtime parts, any other operand a `{…}`
   * hole — `AFTERPAY_URL.$endpoint` → `https://api.example.com{$endpoint}`.
   * Null unless it starts with a literal or a known constant.
   */
  private urlExprAt(node: Node, index: number): string | null {
    const arg = node.childForFieldName("arguments")?.children.filter((c) => c.type === "argument")[index];
    const expr = arg?.namedChildren[arg.namedChildren.length - 1];
    if (!expr) return null;
    const parts: Array<{ text: string; known: boolean }> = [];
    const visit = (n: Node): void => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === ".") {
        visit(n.childForFieldName("left")!);
        visit(n.childForFieldName("right")!);
      } else if (n.type === "parenthesized_expression" && n.namedChildren[0]) {
        visit(n.namedChildren[0]);
      } else if (n.type === "string" || n.type === "encapsed_string") {
        parts.push({ text: n.text.replace(/^['"]|['"]$/g, ""), known: true });
      } else if (n.type === "name" && this.constants.has(n.text)) {
        parts.push({ text: this.constants.get(n.text)!, known: true });
      } else if (n.type === "class_constant_access_expression" && /^(?:self|static)::/.test(n.text) && this.constants.has(n.text.replace(/^\w+::/, ""))) {
        parts.push({ text: this.constants.get(n.text.replace(/^\w+::/, ""))!, known: true });
      } else {
        parts.push({ text: n.type === "variable_name" ? `{${n.text}}` : "{…}", known: false });
      }
    };
    visit(expr);
    if (!parts[0]?.known || !parts[0].text) return null;
    return parts.map((p) => p.text).join("");
  }

  /**
   * The SQL text of a call's first argument: its literals concatenated, every
   * other operand a `?` placeholder (`"… WHERE id ='".$id."'"`). Null when
   * it names no table.
   */
  private sqlText(node: Node, index = 0): string | null {
    const arg = node.childForFieldName("arguments")?.children.filter((c) => c.type === "argument")[index];
    let expr = arg?.namedChildren[arg.namedChildren.length - 1];
    // `$sql = "SELECT …"; mysqli_query($link, $sql)`: the statement the variable was given, once, above.
    if (expr?.type === "variable_name") expr = assignedAbove(expr.text, node) ?? expr;
    if (!expr) return null;
    let text = "";
    const visit = (n: Node): void => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === ".") {
        visit(n.childForFieldName("left")!);
        visit(n.childForFieldName("right")!);
      } else if (n.type === "string" || n.type === "encapsed_string" || n.type === "heredoc" || n.type === "nowdoc") {
        text += n.type === "heredoc" || n.type === "nowdoc"
          ? n.namedChildren.filter((c) => /body|string_content|string_value/.test(c.type)).map((c) => c.text).join(" ")
          : n.text.replace(/^['"]|['"]$/g, "");
      } else {
        text += "?";
      }
    };
    visit(expr);
    return statementAccesses(text).length > 0 ? text : null;
  }

  /** One `database` row per table (or routine) the call's SQL text names. */
  private pushSqlRows(node: Node, callText: string, line: number, sources: DataSourceInfo[], index = 0): void {
    const sql = this.sqlText(node, index);
    if (!sql) return;
    for (const hit of statementAccesses(sql)) {
      const access = hit.routine ? undefined : sqlVerbAccess(hit.verb);
      sources.push(this.ds({
        kind: "database",
        name: callText,
        target: hit.table,
        ...(hit.routine ? { routine: true as const } : { entity: hit.table }),
        ...(access ? { access } : {}),
        ...(hit.joined ? { joined: true as const } : {}),
        line,
      }));
    }
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
        const url = this.urlExprAt(node, 0);
        const handle = curlInitHandle(node);
        if (url && handle) this.curlUrls.set(handle, url);
        return;
      }
      if (fnName === "curl_setopt" || fnName === "curl_setopt_array") {
        const handle = this.argText(node, 0);
        const url = fnName === "curl_setopt"
          ? (this.argText(node, 1) === "CURLOPT_URL" ? this.urlExprAt(node, 2) : null)
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

      // Procedural database extensions: `mysqli_query($link, "SELECT …")`, `pg_query($conn, $sql)`,
      // `sqlsrv_query($conn, …)` — a row per table the statement names, or one with no table.
      const sqlAt = PROCEDURAL_SQL_ARG[fnName.toLowerCase()];
      if (sqlAt !== undefined) {
        const args = node.childForFieldName("arguments")?.children.filter((c) => c.type === "argument").length ?? 0;
        // `pg_query($sql)` / `pg_query_params($sql, $params)`: the connection is optional.
        const index = sqlAt > 0 && /^pg_/i.test(fnName) && args <= sqlAt ? sqlAt - 1 : sqlAt;
        const before = sources.length;
        this.pushSqlRows(node, fnName, line, sources, index);
        if (sources.length === before) sources.push(this.ds({ kind: "database", name: fnName, target: null, line }));
        return;
      }

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
        // `$this->db->query("UPDATE tickets t INNER JOIN …")`: raw SQL, every table it names.
        if (method === "query") {
          this.pushSqlRows(node, callText, line, sources);
          return;
        }
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
        // PDO `query`/`exec`/`prepare` with SQL text: a row per table it names,
        // even inside a chain (`$pdo->query('SELECT …')->fetchAll()`, whose
        // outer verb then adds nothing). Text that is no SQL
        // (`$xpath->query("//table/tr")`) is no data access.
        if (PDO_SQL_VERBS.has(method) && this.sqlText(node) !== null) {
          this.pushSqlRows(node, callText, line, sources);
          return;
        }
        // A literal that is no SQL (`$xpath->query("//table/tr")`) names no table.
        if (PDO_SQL_VERBS.has(method) && this.firstStringArg(node) !== null) return;
        if (/->\s*(?:query|exec|prepare)\(\s*['"]/.test(recvText) && /^fetch/.test(method)) return;
        if (continuesEloquentChain(node)) return;
        // `$request->all()`, `$request->query('page')`: the HTTP request's input, not a model.
        if (REQUEST_INPUT_VERBS.has(method) && objNode && isHttpRequest(objNode, node)) return;
        // A parameter bag, session, cache or message bag shares the verbs (`$request->attributes->get('x')`,
        // `$this->parameters->get('start')`, `$validator->errors()->count()`): no table behind it.
        if (NON_MODEL_RECEIVER_RE.test(recvText)) return;
        if (!this.namespaced && !PDO_HANDLE_RE.test(callText)) return;
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: null,
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

      // `DB::raw("COUNT(id) AS n")` is an expression a builder embeds — no access of its own; the SQL a
      // `DB::select/insert/update/delete/statement` runs names its tables.
      if (scope === "DB" && name === "raw") return;
      if (scope === "DB" && DB_SQL_METHODS.has(name)) {
        const before = sources.length;
        this.pushSqlRows(node, callText, line, sources);
        if (sources.length === before) sources.push(this.ds({ kind: "database", name: callText, target: null, line, ...phpAccess(name) }));
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

/** Procedural database functions → the position of their SQL argument. */
const PROCEDURAL_SQL_ARG: Record<string, number> = {
  mysqli_query: 1, mysqli_real_query: 1, mysqli_multi_query: 1, mysqli_prepare: 1, mysqli_execute_query: 1,
  mysql_query: 0, mysql_unbuffered_query: 0, mysql_db_query: 1,
  pg_query: 1, pg_query_params: 1, pg_send_query: 1, pg_prepare: 2,
  sqlsrv_query: 1, sqlsrv_prepare: 1, mssql_query: 0, oci_parse: 1, odbc_exec: 1, odbc_prepare: 1, db2_exec: 1, db2_prepare: 1,
  sqlite_query: 1, sqlite_exec: 1,
};

/**
 * The expression `name` (a `$variable`) was assigned once in the function (or
 * file) around `at`, before it: `$sql = "SELECT …"`. Null when it is assigned
 * more than once or not at all.
 */
function assignedAbove(name: string, at: Node): Node | null {
  let scope: Node | null = at.parent;
  while (scope && !/^(?:function_definition|method_declaration|anonymous_function|arrow_function|program)$/.test(scope.type)) scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  let count = 0;
  const visit = (n: Node): void => {
    if (count > 1 || n.startIndex > at.startIndex) return;
    if (n !== scope && /^(?:function_definition|method_declaration|anonymous_function|arrow_function|class_declaration)$/.test(n.type)) return;
    if ((n.type === "assignment_expression" || n.type === "augmented_assignment_expression") && n.childForFieldName("left")?.text === name) {
      count += n.type === "assignment_expression" ? 1 : 2;
      found = n.childForFieldName("right");
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return count === 1 ? found : null;
}

/** Laravel `DB::` methods whose first argument is a statement. */
const DB_SQL_METHODS: ReadonlySet<string> = new Set(["select", "selectOne", "scalar", "cursor", "insert", "update", "delete", "statement", "unprepared", "affectingStatement"]);

/**
 * Receivers that are framework bags and stores, never a model or a query: by their last segment.
 * Also a filesystem disk (`$disk->exists($path)`), a collection already fetched
 * (`$collection->count()`), the signed-in user `auth()` hands back, and a project
 * service or factory (`$this->journalService->destroy($j)`), whose own code
 * carries the access it makes.
 */
const NON_MODEL_RECEIVER_RE =
  /(?:->|^\$)(?:attributes|parameters|headers|cookies|files|server|session|cache|config|messages|bag|disk|storage|filesystem|collection|collections|service|factory)$|(?:->|^\$)\w*(?:Service|Factory)$|->(?:query|request)$|->(?:errors|getMessages|getMessageBag|session|cache|config)\(\s*\)$|^(?:session|cache|config|auth)\(\s*\)$/i;

/** A PDO / mysqli handle or statement by its conventional name: `$pdo->query`, `$stmt->fetchAll()`. */
const PDO_HANDLE_RE = /^\$(?:pdo|db|dbh|conn|connection|stmt|statement|sth|mysqli|link)\b|->(?:query|exec|prepare|fetchAll|fetch)$/i;

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
