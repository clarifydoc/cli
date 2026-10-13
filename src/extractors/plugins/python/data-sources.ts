import type { Node } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

export class PythonDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["python"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
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
        if (leaf === "basic_consume") {
          sources.push(this.ds({
            kind: "queue-consume",
            name: "RabbitMQ: basic_consume",
            target: pyArg(node, "queue", 0),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        // requests.get(url), httpx.post(url), session.get("/api/x")
        const http = httpCall(fn!, node);
        if (http) {
          sources.push(this.ds({
            kind: "api-call",
            name: http.name,
            target: http.target,
            line: node.startPosition.row + 1,
          }));
        }

        // os.environ, os.getenv
        if (fnName.includes("os.getenv") || fnName.includes("os.environ")) {
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: null,
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
          const access = isSessionWrite ? "write" : dbAccessFor(leaf, PY_DB_ACCESS);
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
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
    if (PY_HTTP_VERBS.has(leaf)) return { name: `${recv}.${leaf}`, target: pyStringLiteral(args[0]) };
    if (leaf === "request") {
      const method = pyStringLiteral(args[0]);
      return method && PY_HTTP_VERBS.has(method.toLowerCase())
        ? { name: method.toLowerCase(), target: pyStringLiteral(args[1]) }
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

/** Content of a string literal or f-string (`{holes}` kept), else null. */
function pyStringLiteral(node: Node | undefined): string | null {
  if (!node || node.type !== "string") return null;
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}
