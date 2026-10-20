import type { Node } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable, sqlVerbAccess } from "../shared/db-access.js";
import type { DataSourceInfo, JsonSchemaNode, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { tableFrom } from "../shared/sql-string-sources.js";
import { pythonResponseReads } from "./response-reads.js";

export class PythonDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["python"];

  /** Names this file binds to a vector-store client: `qdrant = QdrantClient(…)`, `self.db = chromadb.Client()`. */
  private vectorClients = new Set<string>();
  /** The file names Celery (an import, an app, `shared_task`): its `@x.task` functions are tasks. */
  private celery = false;
  /** Locals holding a Celery signature: `consume_task = consume_file.s(…)` → consume_task → consume_file. */
  private signatures = new Map<string, string>();
  /** The file uses boto3 (SQS/SNS clients) or redis-py (pub/sub). */
  private boto3 = false;
  private redis = false;

  override beginFile(_tree: unknown, sourceText: string): void {
    this.vectorClients = new Set();
    this.celery = /\bcelery\b|\bshared_task\b/i.test(sourceText);
    this.boto3 = /\b(?:boto3|aioboto3)\b/.test(sourceText);
    this.redis = /^\s*(?:import\s+(?:redis|aioredis)|from\s+(?:redis|aioredis)(?:\.\w+)*\s+import)\b/m.test(sourceText);
    this.signatures = new Map();
    if (sourceText.includes(".s(") || sourceText.includes(".si(") || sourceText.includes(".signature(")) {
      for (const m of sourceText.matchAll(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\.(?:s|si|signature)\(/gm)) {
        // Two assignments of one name to different tasks: refuse to choose.
        const prev = this.signatures.get(m[1]!);
        this.signatures.set(m[1]!, prev === undefined || prev === m[2]! ? m[2]! : "");
      }
      for (const [k, v] of this.signatures) if (!v) this.signatures.delete(k);
    }
    if (!/QdrantClient|chromadb|Pinecone|MilvusClient|weaviate/.test(sourceText)) return;
    for (const m of sourceText.matchAll(/(?:^|\s)(?:self\.)?([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]]+\s*)?=\s*(?:await\s+)?(?:[\w.]+\.)?(?:QdrantClient|AsyncQdrantClient|PersistentClient|HttpClient|Client|Pinecone|MilvusClient|WeaviateClient|connect_to_\w+)\s*\(/gm)) {
      // `chromadb.Client()` / `HttpClient()` only from chromadb itself.
      if (/^(?:Client|HttpClient|PersistentClient)$/.test(m[0]!.match(/(\w+)\s*\($/)![1]!) && !/\bchromadb\b/.test(m[0]!) && !/from\s+chromadb\b/.test(sourceText)) continue;
      this.vectorClients.add(m[1]!);
    }
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // `os.environ["DATABASE_URL"]`: an environment read written as a subscript.
    if (node.type === "subscript" && node.childForFieldName("value")?.text === "os.environ") {
      const key = node.childForFieldName("subscript");
      const name = key?.type === "string" ? key.text.replace(/^[rbfu]*['"]{1,3}|['"]{1,3}$/gi, "") : null;
      if (name && /^[A-Za-z_][\w.-]*$/.test(name)) {
        sources.push(this.ds({ kind: "env", name: "os.environ", target: name, line: node.startPosition.row + 1 }));
      }
      return;
    }
    // Celery: a `@app.task` / `@shared_task` function consumes the task queue
    // named after it (or the decorator's `name=`); `.delay`/`.apply_async`
    // and `send_task` publish to it.
    if (node.type === "decorated_definition" && this.celery) {
      const def = node.childForFieldName("definition");
      const task = node.children.find((d) => d.type === "decorator" && CELERY_TASK_RE.test(d.text));
      const name = def?.type === "function_definition" ? def.childForFieldName("name")?.text : undefined;
      if (task && def && name) {
        const call = task.namedChildren.find((c) => c.type === "call");
        const declared = call ? pyArg(call, "name", -1) : null;
        sources.push(this.ds({
          kind: "queue-consume",
          name: "Celery: task",
          target: declared ? declared.split(".").pop()! : name,
          line: def.startPosition.row + 1,
        }));
      }
      return;
    }
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const fnName = fn?.text;

      if (fnName) {
        // pika (RabbitMQ): channel.basic_publish(exchange=, routing_key=, body=)
        // / channel.basic_consume(queue=, on_message_callback=). The method
        // names are AMQP-specific, so any receiver is trusted.
        const leaf = fnName.split(".").pop()!;
        if (leaf === "basic_publish") {
          const routingKey = pyArg(node, "routing_key", 1);
          sources.push(this.ds({
            kind: "queue-publish",
            name: "RabbitMQ: basic_publish",
            target: pyArg(node, "exchange", 0),
            ...(routingKey ? { entity: routingKey } : {}),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        if ((leaf === "delay" || leaf === "apply_async") && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.(?:delay|apply_async)$/.test(fnName)) {
          const held = fnName.split(".").slice(-2, -1)[0]!;
          // A signature kept in a local (`consume_task = consume_file.s(…)`) is the task it signs.
          const task = (fnName === `${held}.${leaf}` ? this.signatures.get(held) : undefined) ?? held;
          if (task !== "self" && task !== "cls") {
            sources.push(this.ds({ kind: "queue-publish", name: `Celery: ${leaf}`, target: task, line: node.startPosition.row + 1 }));
            return;
          }
        }
        if (leaf === "send_task" && fnName.includes(".")) {
          const task = pyArg(node, "name", 0);
          if (task && /^[\w.]+$/.test(task)) {
            sources.push(this.ds({ kind: "queue-publish", name: "Celery: send_task", target: task.split(".").pop()!, line: node.startPosition.row + 1 }));
            return;
          }
        }
        // boto3: `sqs.send_message(QueueUrl=…)`, `sqs.receive_message(QueueUrl=…)`, `sns.publish(TopicArn=…)`.
        if (this.boto3 && (leaf === "send_message" || leaf === "send_message_batch" || leaf === "receive_message" || (leaf === "publish" && /sns/i.test(fnName)))) {
          const raw = pyArg(node, leaf === "publish" ? "TopicArn" : "QueueUrl", -1);
          const target = raw ? queueName(raw) : null;
          if (target) {
            sources.push(this.ds({
              kind: leaf === "receive_message" ? "queue-consume" : "queue-publish",
              name: leaf === "publish" ? "SNS: publish" : leaf === "receive_message" ? "SQS: receive" : "SQS: send",
              target,
              line: node.startPosition.row + 1,
            }));
            return;
          }
        }
        // redis-py pub/sub: `r.publish("orders", msg)`, `p.subscribe("orders")`.
        if (this.redis && (leaf === "publish" || leaf === "subscribe" || leaf === "psubscribe") && fnName.includes(".")) {
          const channel = pyArg(node, "channel", 0);
          if (channel && /^[\w.:*-]+$/.test(channel)) {
            sources.push(this.ds({ kind: leaf === "publish" ? "queue-publish" : "queue-consume", name: `Redis: ${leaf}`, target: channel, line: node.startPosition.row + 1 }));
            return;
          }
        }
        if (leaf === "basic_consume") {
          sources.push(this.ds({
            kind: "queue-consume",
            name: "RabbitMQ: basic_consume",
            target: pyArg(node, "queue", 0),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        // A vector store's collection operations: `qdrant.upsert(collection_name="chunks", …)`.
        const recv = fnName.split(".").slice(0, -1).filter((p) => p !== "self").pop() ?? "";
        if (this.vectorClients.has(recv)) {
          const access = PY_VECTOR_READS.test(leaf) ? "read" : PY_VECTOR_WRITES.test(leaf) ? "write" : null;
          if (access) {
            const collection = pyArg(node, "collection_name", 0) ?? pyArg(node, "name", 0);
            const named = collection && /^[\w.-]+$/.test(collection) ? collection : null;
            sources.push(this.ds({
              kind: "database",
              name: fnName,
              target: named,
              ...(named ? { entity: named } : {}),
              line: node.startPosition.row + 1,
              access,
            }));
          }
          return;
        }

        // requests.get(url), httpx.post(url), session.get("/api/x")
        const http = httpCall(fn!, node);
        if (http) {
          const body = jsonBody(node);
          const reads = pythonResponseReads(node);
          sources.push(this.ds({
            kind: "api-call",
            name: http.name,
            target: http.target,
            line: node.startPosition.row + 1,
            ...(body ? { requestBody: body } : {}),
            ...(reads ? { responseReads: reads } : {}),
          }));
        }

        // os.environ, os.getenv
        if (fnName.includes("os.getenv") || fnName.includes("os.environ")) {
          // The variable read: `os.getenv("DATABASE_URL")`, `os.environ.get("X", default)`.
          const key = pyArg(node, "key", 0);
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: key && /^[A-Za-z_][\w.-]*$/.test(key) ? key : null,
            line: node.startPosition.row + 1,
          }));
        }

        // Database patterns — matched on the exact method LEAF, not substring:
        // `RE_CPP_CLASSNAME.findall(...)` (the re module) contains ".find" but
        // is not a DB op, and it was minting phantom regex-constant "entities".
        const parts = fnName.split(".");
        const receiver = parts.length > 1 ? parts[parts.length - 2]! : "";
        // Session-mutating verbs are ordinary English words (`add`, `delete`,
        // `merge`), so unlike the leaves above they are only trusted on a
        // session/connection-shaped receiver. Without them a SQLAlchemy write
        // was invisible: `session.add(order)` produced no data source at all,
        // and the file reported `writesState: false`.
        const isSessionWrite =
          PY_SESSION_WRITE_LEAVES.has(leaf) && PY_DB_RECEIVER_RE.test(receiver);
        // Generic verbs (`execute`, `find`, `filter`, `query`) are also every
        // interpreter's, string's and ElementTree's: they need the chain to
        // show a datastore — a session/cursor/collection receiver, a Django
        // manager (`.objects`), a SQLAlchemy query (`.query(...)`).
        const isQuery =
          PY_DB_LEAVES.has(leaf) ||
          (PY_GENERIC_DB_LEAVES.has(leaf) && (datastoreChain(fnName) || relatedManager(fnName, leaf)));
        if (fnName.includes(".") && (isQuery || isSessionWrite)) {
          let access = isSessionWrite ? "write" : dbAccessFor(leaf, PY_DB_ACCESS);
          // Raw SQL (`cursor.execute(sql)`, `session.execute(text(q))`): the
          // statement names the table and says whether it reads or writes —
          // read from a literal or a local assigned one.
          let table: string | null = null;
          if (SQL_TEXT_LEAVES.has(leaf)) {
            let arg = positional(node)[0];
            if (arg?.type === "call" && /(?:^|\.)text$/.test(arg.childForFieldName("function")?.text ?? "")) arg = positional(arg)[0];
            const sql = arg ? pyStringValue(arg, node) : null;
            const hit = sql ? tableFrom(sql.replace(/\{[^}]*\}/g, "x")) : null;
            if (hit) {
              table = hit.table;
              access ??= sqlVerbAccess(hit.verb);
            }
          }
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: table,
            line: node.startPosition.row + 1,
            ...(table ? { entity: table } : {}),
            ...(access ? { access } : {}),
          }));
        }
      }
    }
  }
}

/**
 * Method leaves that indicate a DB op on any receiver (SQLAlchemy / Django ORM
 * / pymongo / DB-API). `save` stays here: Django's `order.save()` is the write,
 * and a project class's own `save` is dropped once the linker resolves it
 * (`demoteProjectCallDataSources`).
 */
const PY_DB_LEAVES = new Set([
  "executemany", "find_one", "find_many", "filter_by", "get_or_create", "save",
  "insert_one", "insert_many", "update_one", "update_many",
  "delete_one", "delete_many", "count_documents",
]);

/** DB verbs that are also ordinary method names — trusted only on a datastore-shaped chain. */
const PY_GENERIC_DB_LEAVES = new Set(["query", "execute", "find", "filter", "all", "first", "aggregate"]);

/** A receiver segment that names a datastore handle or an ORM query. */
const PY_DATASTORE_SEGMENT_RE = /(^|_)(session|db|conn|connection|cursor|cur|engine|collection|coll|database|queryset|qs)$/i;

/**
 * A Django related manager queried — `user.orders.all()`,
 * `self.items.filter(...)`: a set-returning verb on an attribute of an object
 * (two or more plain names). A single receiver (`mask.all()`, `ast.filter`)
 * is any other object's method.
 */
function relatedManager(fnName: string, leaf: string): boolean {
  return (leaf === "all" || leaf === "first" || leaf === "filter") &&
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,}$/.test(fnName);
}

/**
 * Does the receiver chain of `fnName` (leaf dropped) show a datastore? A
 * segment shaped like a session/cursor/collection, a Django manager
 * (`Order.objects.filter`), or a SQLAlchemy query (`session.query(User).first`,
 * Flask-SQLAlchemy `User.query.filter_by`).
 */
function datastoreChain(fnName: string): boolean {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < fnName.length; i++) {
    const c = fnName[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "." && depth === 0) {
      segments.push(fnName.slice(start, i));
      start = i + 1;
    }
  }
  return segments.some((seg) => {
    const name = seg.replace(/[([].*$/s, "").trim();
    return name === "objects" || name === "query" || PY_DATASTORE_SEGMENT_RE.test(name);
  });
}

/**
 * Session/connection-mutating verbs. Plain English words, so they need a
 * DB-shaped receiver before they count.
 */
const PY_SESSION_WRITE_LEAVES = new Set([
  "add", "add_all", "delete", "merge", "commit", "flush", "bulk_save_objects",
]);

/** Receiver names that read as a SQLAlchemy session / DB-API connection. */
const PY_DB_RECEIVER_RE = /(^|_)(session|db|conn|connection|cursor|engine)$/i;

/**
 * Read/write classification for the leaves above. `execute`/`executemany` stay
 * unclassified: the statement's verb decides, and it is not visible here.
 */
const PY_DB_ACCESS = dbVerbTable(
  [
    "query", "find", "find_one", "find_many", "filter", "filter_by",
    "all", "first", "count_documents", "aggregate",
  ],
  [
    "insert_one", "insert_many", "update_one", "update_many",
    "delete_one", "delete_many", "save", "get_or_create",
  ],
);

/**
 * Resolve a call argument by keyword (`queue="tasks"`) or position, returning
 * a string literal's unquoted value or any other expression's source text
 * (`config.EXCHANGE` — still a usable join label). Empty-string literals
 * (pika's default exchange) return null.
 */
/** Vector-store client calls that read or write a collection (Qdrant, Chroma, Pinecone, Milvus). */
const PY_VECTOR_READS = /^(?:search|search_batch|query|query_points|query_batch_points|retrieve|scroll|count|recommend|discover|get_collection|get|collection_exists|get_or_create_collection|get_collection|facet)$/;
const PY_VECTOR_WRITES = /^(?:upsert|delete|create_collection|recreate_collection|delete_collection|update_collection|set_payload|overwrite_payload|delete_payload|clear_payload|update_vectors|delete_vectors|batch_update_points|create_payload_index|add|insert|update)$/;

/** `@app.task`, `@celery.task(bind=True)`, `@shared_task` — not a bare `@task` (Invoke, Prefect). */
const CELERY_TASK_RE = /^@\s*(?:[A-Za-z_]\w*\.)+task\b|^@\s*shared_task\b/;

function pyArg(call: Node, keyword: string, index: number): string | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  let value: Node | null = null;
  let positional = 0;
  for (const a of args.namedChildren) {
    if (a.type === "keyword_argument") {
      if (a.childForFieldName("name")?.text === keyword) {
        value = a.childForFieldName("value");
        break;
      }
    } else if (a.type !== "comment") {
      if (positional === index && value === null) value = a;
      positional++;
    }
  }
  if (!value) return null;
  const text = value.type === "string"
    ? value.text.replace(/^[rbfu]*['"]{1,3}|['"]{1,3}$/gi, "")
    : value.text.replace(/\s+/g, " ");
  return text && text.length <= 64 ? text : null;
}

/**
 * A queue or topic named by its URL, ARN or the variable holding it: the URL's
 * last segment, the ARN's, an `os.environ[…]` / `os.getenv(…)` name, or the identifier.
 */
function queueName(raw: string): string | null {
  const env = /os\.(?:environ\[\s*['"]([^'"]+)['"]\s*\]|getenv\(\s*['"]([^'"]+)['"]|environ\.get\(\s*['"]([^'"]+)['"])/.exec(raw);
  if (env) return env[1] ?? env[2] ?? env[3]!;
  if (/^[A-Za-z_][\w.]*$/.test(raw)) return raw.split(".").pop()!;
  const last = raw.split(/[/:]/).filter(Boolean).pop();
  return last && /^[\w.-]+$/.test(last) ? last : null;
}

/** HTTP client modules whose verb functions are always outbound calls. */
const PY_HTTP_MODULES = new Set(["requests", "httpx", "aiohttp"]);
const PY_HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/** A client/session object (`session.get`, `self.client.post`) — an HTTP call only with a URL-shaped argument. */
const PY_HTTP_RECEIVER_RE = /(^|_)(session|client|http)$/i;

/**
 * An outbound HTTP call, decided on the call's SHAPE rather than on a substring
 * of its text. The old substring test (`fnName.includes("requests.")`) read
 * `pending_requests.get("task_type")`, `httpx.Response(200)` and
 * `requests.get(url).json().get("page")` as HTTP calls, with the first
 * argument's raw text — a variable name, a status code — as the URL.
 *
 * Accepted: `<module>.<verb>(…)` on requests / httpx / aiohttp, and
 * `<module>.request(VERB, url)`; or a verb on a session/client receiver whose
 * first argument is a URL-shaped string. The target is a string literal's
 * content (an f-string keeps its `{holes}`), else null — a variable's name is
 * not a URL.
 */
function httpCall(fn: Node, call: Node): { name: string; target: string | null } | null {
  if (fn.type !== "attribute") return null;
  const leaf = fn.childForFieldName("attribute")?.text ?? "";
  const obj = fn.childForFieldName("object");
  if (!obj) return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "keyword_argument") ?? [];
  const recv = obj.type === "identifier" ? obj.text : obj.type === "attribute" ? obj.childForFieldName("attribute")?.text ?? "" : "";

  if (obj.type === "identifier" && PY_HTTP_MODULES.has(recv)) {
    // Named by its verb, as a client receiver's call is: the route linker reads the method off the name.
    if (PY_HTTP_VERBS.has(leaf)) return { name: leaf, target: args[0] ? pyStringValue(args[0], call) : null };
    if (leaf === "request") {
      const method = pyStringLiteral(args[0]);
      return method && PY_HTTP_VERBS.has(method.toLowerCase())
        ? { name: method.toLowerCase(), target: args[1] ? pyStringValue(args[1], call) : null }
        : null;
    }
    return null;
  }
  if (PY_HTTP_VERBS.has(leaf) && PY_HTTP_RECEIVER_RE.test(recv)) {
    const target = pyStringLiteral(args[0]);
    if (target && (target.includes("/") || /^https?:/i.test(target))) return { name: leaf, target };
  }
  return null;
}

/**
 * The body a `requests`/`httpx` call states as `json={...}` (a dict literal,
 * or a name bound to one in the enclosing function), typed by literal values.
 */
function jsonBody(call: Node): JsonSchemaNode | null {
  let value: Node | null = null;
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === "json") value = a.childForFieldName("value");
  }
  if (value?.type === "identifier") value = pyLocalValue(value);
  return value?.type === "dictionary" ? dictSchema(value, 0) : null;
}

function dictSchema(d: Node, depth: number): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  let open = false;
  for (const c of d.namedChildren) {
    if (c.type === "pair") {
      const key = pyStringLiteral(c.childForFieldName("key") ?? undefined);
      if (key !== null) properties[key] = pyValueSchema(c.childForFieldName("value"), depth);
      else open = true;
    } else if (c.type === "dictionary_splat") open = true;
  }
  return { type: "object", properties, ...(open ? { additionalProperties: true } : {}) };
}

function pyValueSchema(v: Node | null, depth: number): JsonSchemaNode {
  if (!v || depth > 4) return {};
  switch (v.type) {
    case "string": return { type: "string" };
    case "integer": return { type: "integer" };
    case "float": return { type: "number" };
    case "true": case "false": return { type: "boolean" };
    case "none": return { nullable: true };
    case "list": { const f = v.namedChildren[0]; return { type: "array", ...(f ? { items: pyValueSchema(f, depth + 1) } : {}) }; }
    case "dictionary": return dictSchema(v, depth + 1);
    default: return {};
  }
}

/** The value last assigned to a bare name earlier in the enclosing function (or module). */
function pyLocalValue(name: Node): Node | null {
  let scope: Node | null = name.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  const visit = (n: Node): void => {
    if (n.startIndex >= name.startIndex) return;
    if (n !== scope && n.type === "function_definition") return;
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name.text) found = n.childForFieldName("right");
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return found;
}

/** Content of a string literal or f-string (`{holes}` kept), else null. */
function pyStringLiteral(node: Node | undefined): string | null {
  if (!node || node.type !== "string") return null;
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}

/** DB-API / SQLAlchemy calls whose first argument is the SQL text. */
const SQL_TEXT_LEAVES = new Set(["execute", "executemany", "executescript", "raw"]);

/** A call's positional arguments, in order. */
function positional(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
}

/**
 * The text a string-valued expression holds, as far as the source says:
 * a literal (an f-string keeps its `{holes}`), a `+` of literals and names (a
 * name that resolves contributes its text, any other part a `{}` hole), or a
 * local name assigned exactly once in the enclosing function from one of
 * those (`url = f"{BASE}/users/{id}"; requests.get(url)`). Null when the
 * expression carries no literal text at all.
 */
function pyStringValue(node: Node, at: Node, depth = 0): string | null {
  if (depth > 3) return null;
  if (node.type === "string") return pyStringLiteral(node);
  if (node.type === "concatenated_string") {
    const parts = node.namedChildren.map((c) => pyStringValue(c, at, depth + 1));
    return parts.every((p) => p !== null) ? parts.join("") : null;
  }
  if (node.type === "parenthesized_expression" && node.namedChild(0)) return pyStringValue(node.namedChild(0)!, at, depth + 1);
  if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
    const l = node.childForFieldName("left");
    const r = node.childForFieldName("right");
    const lv = l ? pyStringValue(l, at, depth + 1) : null;
    const rv = r ? pyStringValue(r, at, depth + 1) : null;
    if (lv === null && rv === null) return null;
    return `${lv ?? "{}"}${rv ?? "{}"}`;
  }
  if (node.type === "identifier") {
    const value = singleAssignment(node.text, at);
    return value ? pyStringValue(value, value, depth + 1) : null;
  }
  return null;
}

/** The value `name` is assigned in the function enclosing `at`, when it is assigned exactly once there (else null). */
function singleAssignment(name: string, at: Node): Node | null {
  let scope: Node | null = at.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!scope) return null;
  let found: Node | null = null;
  let count = 0;
  const visit = (n: Node): void => {
    if (count > 1) return;
    if (n !== scope && (n.type === "function_definition" || n.type === "class_definition")) return;
    if (n.type === "assignment" && n.childForFieldName("left")?.text === name) {
      count++;
      found = n.childForFieldName("right");
    } else if ((n.type === "augmented_assignment" || n.type === "for_statement") && n.childForFieldName("left")?.text === name) {
      count += 2;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return count === 1 ? found : null;
}
