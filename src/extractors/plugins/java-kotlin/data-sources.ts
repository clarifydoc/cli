import { constantString } from "./constant-expr.js";
import type { Node, Tree } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable, sqlVerbAccess } from "../shared/db-access.js";
import { routineCalled, tableFrom } from "../shared/sql-string-sources.js";
import type { CallBaseRef, DataSourceInfo, Language, PathArgCall } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { simpleTypeName } from "../../shared/type-parser.js";
import { kotlinNameAndType } from "./functions-classes.js";

/**
 * Java / Kotlin data-source extractor — surfaces jOOQ, Spring Data / JPA,
 * JdbcTemplate / EntityManager, and HTTP-client calls as DataSourceInfo entries.
 *
 * Two AST shapes are handled uniformly via {@link resolveCall}:
 *   - Java  `method_invocation` — has `name` / `object` / `arguments` fields.
 *   - Kotlin `call_expression`  — `navigation_expression(receiver, .method)` +
 *     `call_suffix > value_arguments`; it has NO `name`/`function` field, which
 *     is why the previous field-name-based extractor emitted nothing for Kotlin.
 *
 * jOOQ is the data layer for the analysed server, so the touched **table** is
 * pulled from the query builder's first argument and stored on `ds.entity`
 * (mirroring the C# EF DbSet resolution) — this is what bridges a trace to the
 * Data Model via `attributeDataAccessToSymbols`. A `database` source with no
 * `entity` never reaches `symbolDataAccess`, so capturing the table is the whole
 * point.
 */

/**
 * jOOQ query-builder verbs whose FIRST argument is the table being touched
 * (`selectFrom(STUDENT)`, `insertInto(Tables.X)`, `.from(table("sps.Module"))`,
 * `.join(REIMBURSEMENT)`). Generic words like `from`/`update`/`join` are only
 * trusted when the argument looks like a table reference (see {@link extractTable}),
 * so `LocalDate.from(instant)` / `service.update(dto)` never produce a source.
 */
const JOOQ_TABLE_VERBS = new Set([
  "selectFrom", "insertInto", "update", "deleteFrom", "delete", "mergeInto",
  "from", "join", "leftJoin", "rightJoin", "innerJoin", "fullJoin",
  "crossJoin", "leftOuterJoin", "rightOuterJoin", "fullOuterJoin",
  "naturalJoin", "naturalLeftOuterJoin", "naturalRightOuterJoin", "straightJoin",
]);

/** jOOQ table wrappers — `table("name")` / `tableByName(...)` literal forms. */
const JOOQ_TABLE_FNS = new Set(["table", "tableByName"]);

/**
 * Spring Data repository methods worth flagging as DB access, by exact name.
 * (Bare `delete` / `update` / `remove` are intentionally excluded — they collide
 * with `File.delete()`, `view.update()`, etc.; the derived-query form below
 * covers `deleteByX`.)
 */
const SPRING_DATA_EXACT = new Set([
  "findAll", "findAllById", "save", "saveAll", "saveAndFlush",
  "deleteAll", "deleteAllInBatch", "deleteInBatch",
  "getOne", "getById", "getReferenceById", "count",
]);

/**
 * Spring Data derived-query form: a query verb immediately followed by `By<Upper>`
 * (`findByEmail`, `deleteById`, `countByStatus`, `existsByName`,
 * `findFirst10ByAge`). The optional `First<n>`/`Top<n>`/`Distinct` qualifier sits
 * between the verb and `By`.
 */
const SPRING_DATA_DERIVED =
  /^(find|read|get|query|stream|count|exists|delete|remove)(First\d*|Top\d*|Distinct)?By[A-Z]/;

/**
 * JdbcTemplate / EntityManager raw-SQL & ORM methods. Gated on a DB-shaped
 * receiver because the names (`query`, `update`, `execute`, `merge`, `remove`)
 * are otherwise far too generic.
 */
const JDBC_READS = [
  "query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "getResultList", "getSingleResult",
  // EntityManager / Hibernate Session by class literal.
  "find", "getReference", "get", "load", "createCriteria", "list", "uniqueResult",
];
const JDBC_WRITES = ["update", "batchUpdate", "persist", "merge", "remove", "save", "saveOrUpdate", "delete"];
const JDBC_METHODS = new Set([
  ...JDBC_READS, ...JDBC_WRITES,
  // Neither a read nor a write by name: the statement or the entity's state decides.
  "execute", "createQuery", "createNativeQuery", "createSQLQuery", "createNamedQuery", "getNamedQuery", "refresh", "detach",
]);
/**
 * A JDBC / JPA / Hibernate handle, read on the receiver's LAST segment:
 * `jdbcTemplate`, `hibernateTemplate`, `entityManager`, `em`, `session`,
 * `sessionFactory.getCurrentSession()`. A substring anywhere in the chain
 * matched `kitTemplateService.merge(x)` — a service call — 362 times on one real codebase.
 */
const JDBC_RECEIVER_RE = /^(?:\w*jdbc\w*|\w*(?:hibernate|jpa|mongo|sqlsession|r2dbcentity)template|entitymanager\w*|em|\w*session|get(?:current)?session|getentitymanager|gethibernatetemplate|getjdbctemplate)$/i;
/** Sessions that are not a database's: an HTTP or WebSocket session, a messaging one. */
const NON_DB_SESSION_RE = /^(?:http|web|ws|websocket|stomp|jms|mail|ssh|sftp|user|client|browser)\w*session$/i;
/** A receiver NAMED like a service-layer object is not a data store, whatever it is declared as. */
const SERVICE_LAYER_NAME_RE = /(?:Service|ServiceImpl|Controller|Facade|Handler|Resource|Client|Gateway|Helper|Component|Action)$/;

/** The receiver's last segment with any call parentheses dropped: `a.getSession()` → `getSession`. */
function receiverLeaf(receiver: string): string {
  let depth = 0;
  let k = receiver.length - 1;
  for (; k >= 0; k--) {
    const ch = receiver[k]!;
    if (ch === ")") depth++;
    else if (ch === "(") depth--;
    else if (ch === "." && depth === 0) break;
  }
  return receiver.slice(k + 1).replace(/\(.*$/s, "").trim();
}

/** JPA calls whose argument IS the entity instance: its declared type names the entity. */
const JPA_INSTANCE_METHODS = new Set(["persist", "merge", "remove", "refresh", "detach", "saveOrUpdate", "delete", "update", "save"]);

/** An extension client's verbs (Halo `ReactiveExtensionClient`). */
const EXTENSION_CLIENT_METHODS = new Set(["fetch", "get", "list", "listAll", "listBy", "pageBy", "create", "update", "delete", "watch"]);
const EXTENSION_CLIENT_WRITES = new Set(["create", "update", "delete"]);

/** `{ access }` when classified, `{}` when not — keeps the field absent rather than null. */
function withAccess(a: "read" | "write" | undefined): { access?: "read" | "write" } {
  return a ? { access: a } : {};
}

/**
 * Read/write classification for the JVM data paths. A verb prefix decides the
 * derived and DAO forms (`findByEmail` reads, `deleteById` writes); the exact
 * sets cover the rest. `execute`, `createQuery` and friends stay unclassified
 * because the statement, not the method, carries the verb.
 */
const SPRING_DATA_ACCESS = dbVerbTable(
  ["findAll", "findAllById", "getOne", "getById", "getReferenceById", "count"],
  ["save", "saveAll", "saveAndFlush", "deleteAll", "deleteAllInBatch", "deleteInBatch"],
);

const JDBC_ACCESS = dbVerbTable(JDBC_READS, JDBC_WRITES);

/** Calls whose first argument names a stored routine (or is a `{call x(?)}` statement). */
const STORED_ROUTINE_METHODS = new Set([
  "prepareCall", "withProcedureName", "withFunctionName", "createStoredProcedureQuery", "createStoredProcedureCall",
]);

/** CXF `WebClient` methods that send the request, and the verb each sends (`invoke`/`method` name theirs). */
const CXF_VERB: Record<string, string> = { get: "GET", post: "POST", put: "PUT", delete: "DELETE", head: "HEAD", options: "OPTIONS", form: "POST" };
const CXF_SEND_METHODS = new Set([...Object.keys(CXF_VERB), "invoke", "method"]);
/** Calls that create a `WebClient` from its base address: `WebClient.create(base)`, a project factory's `createWebClient(base, …)`. */
const CXF_CLIENT_FACTORIES = new Set(["create", "createWebClient"]);

/** The `name.x(…)` calls in the method enclosing `at` that come before it, in source order. */
function cxfCallsOn(at: Node, name: string): Node[] {
  let fn: Node | null = at.parent;
  while (fn && !/^(?:method_declaration|constructor_declaration|lambda_expression)$/.test(fn.type)) fn = fn.parent;
  if (!fn) return [];
  const out: Node[] = [];
  const scan = (n: Node): void => {
    if (n.startIndex >= at.startIndex) return;
    if (n.type === "method_invocation" && n.childForFieldName("object")?.text.replace(/^this\./, "") === name) out.push(n);
    for (const c of n.namedChildren) scan(c);
  };
  scan(fn);
  return out;
}

/** QueryDSL query-factory and query methods that take the path of the entity they read or write. */
const QUERYDSL_VERBS = new Set(["selectFrom", "from", "join", "innerJoin", "leftJoin", "rightJoin", "fullJoin", "update", "delete", "insert", "insertInto"]);
const QUERYDSL_WRITES = new Set(["update", "delete", "insert", "insertInto"]);

/** Leading verb of a derived query or DAO method. */
const JVM_READ_VERB_RE = /^(find|read|get|fetch|load|list|search|select|query|stream|count|exists|all)/i;
const JVM_WRITE_VERB_RE = /^(save|store|insert|create|add|update|merge|upsert|persist|delete|remove)/i;

/** Classify by leading verb — reads first, since `getOrCreate` reads before it writes. */
function jvmVerbAccess(method: string): "read" | "write" | undefined {
  if (JVM_READ_VERB_RE.test(method)) return "read";
  if (JVM_WRITE_VERB_RE.test(method)) return "write";
  return undefined;
}

/** jOOQ query builders: `selectFrom`/`from`/`join` read, the DML entry points write. */
const JOOQ_ACCESS = dbVerbTable(
  ["select", "selectFrom", "selectDistinct", "selectCount", "from", "join", "leftJoin", "rightJoin", "innerJoin", "fetch"],
  ["insertInto", "update", "deleteFrom", "delete", "mergeInto", "truncate"],
);

/**
 * jOOQ's `delete(TABLE)` (the older spelling of `deleteFrom`) shares its name
 * with every cache, file and DAO `delete`, so beyond the table-shaped argument
 * it must sit in a query chain: on a DSL context (`dsl`, `ctx`,
 * `JooqFactory.getDSL()`, `DSL.using(cfg)`) or followed by the statement's own
 * steps (`.where(…)`, `.execute()`).
 */
const JOOQ_DSL_RECEIVER_RE = /(?:dsl|ctx|context|jooq|create|using)$/i;
const JOOQ_DELETE_STEP_RE = /^\s*\.\s*(?:where|execute|executeAsync|returning|returningResult|using|limit|orderBy)\s*\(/;

function isJooqDeleteChain(node: Node, receiver: string): boolean {
  if (JOOQ_DSL_RECEIVER_RE.test(receiverLeaf(receiver))) return true;
  let top = node;
  while (top.parent && /^(?:method_invocation|navigation_expression|navigation_suffix|call_expression|call_suffix)$/.test(top.parent.type)) top = top.parent;
  return JOOQ_DELETE_STEP_RE.test(top.text.slice(node.endIndex - top.startIndex));
}

/** HTTP-client hints anywhere in the call text, plus Spring REST method names. */
const HTTP_HINT_RE = /RestTemplate|WebClient|HttpClient|OkHttpClient|Retrofit/;
/** RestTemplate methods whose first argument is the URL. */
const REST_TEMPLATE_URL_FIRST = new Set(["exchange", "getForObject", "getForEntity", "postForObject", "postForEntity", "postForLocation", "put", "delete", "patchForObject"]);

/** `exchange(url, HttpMethod.POST, …)`: the verb its second argument names. */
function exchangeVerb(node: Node): string | null {
  const second = callArguments(node)[1]?.text ?? "";
  return /\bHttpMethod\.(GET|POST|PUT|DELETE|PATCH)\b/.exec(second)?.[1] ?? null;
}

const HTTP_METHODS = new Set([
  "exchange", "getForObject", "getForEntity",
  "postForObject", "postForEntity", "postForLocation",
  "retrieve",
]);

/** The calls that send a request on an HTTP client object. */
const HTTP_SEND_METHODS = new Set(["execute", "enqueue", "send", "sendAsync", "get", "post", "put", "delete", "patch", "head"]);

/**
 * The URL a request builder is given, when this call is that step. A Kotlin
 * template keeps its holes in the `${…}` notation every URL fold renders
 * (`"$baseUrl/api/cars"` → `${baseUrl}/api/cars`), so core splits an unknown
 * leading base off and an absolute host survives as another service.
 */
/** The URL argument of the `URI.create(x)` / `new URL(x)` an `openConnection()` chain starts from. */
function findUrlArg(node: Node): Node | null {
  return urlArgFrom(node.childForFieldName("object"));
}

/** The URL argument of the `URI.create(x)` / `new URL(x)` an expression (`URI.create(x).toURL()`) starts from. */
function urlArgFrom(start: Node | null): Node | null {
  let cur: Node | null = start;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.type === "object_creation_expression" && /^(?:URL|URI)$/.test(simpleTypeName(cur.childForFieldName("type")?.text) ?? "")) return firstJavaArg(cur.childForFieldName("arguments"));
    if (cur.type === "method_invocation" && cur.childForFieldName("name")?.text === "create" && cur.childForFieldName("object")?.text === "URI") return firstJavaArg(cur.childForFieldName("arguments"));
    cur = cur.childForFieldName("object");
  }
  return null;
}

function builtRequestUrl(node: Node, call: CallParts): { target: string | null } | null {
  const { method, receiver } = call;
  const builds =
    (method === "url" && /\bRequest\s*\.\s*Builder\s*\(/.test(receiver)) ||
    ((method === "newBuilder" || method === "uri") && /\bHttpRequest\b/.test(receiver));
  if (!builds || !call.firstArg) return null;
  const url = urlExpression(call.firstArg, node, 0);
  // An absolute URL, an app path, or a path behind an unknown base — never a bare hole: a
  // request built for a URL the method is handed (`HttpRequest.newBuilder(URI.create(url))`)
  // is still a request, to a target nobody wrote here.
  return { target: url && /^(?:https?:\/\/|\/|(?:\$\{[^{}]*\})+\/)/.test(url) ? url : null };
}

/** The text of the method (or lambda) body enclosing `node`, else the file's. */
function enclosingBodyText(node: Node): string {
  let cur: Node | null = node.parent;
  while (cur && !/^(?:method_declaration|constructor_declaration|function_declaration|lambda_expression|lambda_literal|anonymous_function)$/.test(cur.type)) cur = cur.parent;
  return (cur ?? node.tree.rootNode).text;
}

/** A receiver named as an HTTP client, whatever its case (`httpClient`, `this.okHttpClient`), never a collection of them. */
const CLIENT_NAMED_RE = /(?:^|\.)(?:http|okHttp|rest|web)Client$/i;
/** A request built where it is sent: the builder step records it, so the send adds nothing. */
const REQUEST_BUILDER_RE = /\bHttpRequest\s*\.\s*newBuilder\b|\bRequest\s*\.\s*Builder\s*\(/;

/**
 * The text of a URL expression: a string literal (Kotlin templates rendered),
 * `URI.create(x)` / `URI(x)` / `new URI(x)`, a `+` concatenation with at least
 * one literal part (other parts become holes), or a local `val url = …`
 * declared before the call in the enclosing function. Null when nothing in it
 * is written out.
 */
/** The string constants of the file being read, which a URL expression may name. */
let fileStringConsts: ReadonlyMap<string, string> = new Map();

function urlExpression(expr: Node, at: Node, depth: number): string | null {
  if (depth > 3) return null;
  switch (expr.type) {
    case "string_literal":
    case "line_string_literal":
    case "multi_line_string_literal":
      // A `$name` hole naming a local string (`val endpoint = "cars/v1"`) is filled in.
      return renderStringLiteral(expr, (name) => {
        const init = localInitializer(at, name);
        return init ? urlExpression(init, at, depth + 1) : null;
      });
    case "parenthesized_expression": {
      const inner = expr.namedChildren.find((c) => c.type !== "comment");
      return inner ? urlExpression(inner, at, depth) : null;
    }
    case "object_creation_expression": {
      // Java `new URI(x)`.
      if (simpleTypeName(expr.childForFieldName("type")?.text) !== "URI") return null;
      const arg = firstJavaArg(expr.childForFieldName("arguments"));
      return arg ? urlExpression(arg, at, depth + 1) : null;
    }
    case "method_invocation":
    case "call_expression": {
      // `URI.create(x)`, Kotlin `URI(x)`.
      const inner = resolveCall(expr);
      const isUri = inner && ((inner.method === "create" && /(?:^|\.)URI$/.test(inner.receiver.trim())) || (inner.method === "URI" && !inner.receiver));
      return isUri && inner.firstArg ? urlExpression(inner.firstArg, at, depth + 1) : null;
    }
    case "additive_expression":
    case "binary_expression": {
      const parts = concatParts(expr);
      if (!parts) return null;
      let literal = false;
      let out = "";
      for (const part of parts) {
        const text = urlExpression(part, at, depth + 1);
        if (text !== null) { literal = true; out += text; }
        else out += "${" + part.text.replace(/\s+/g, " ") + "}";
      }
      return literal ? out : null;
    }
    case "identifier":
    case "simple_identifier": {
      const init = localInitializer(at, expr.text);
      // …or a string constant of the file (`private static final String API_PATH = "/v6"`).
      return init ? urlExpression(init, at, depth + 1) : (fileStringConsts.get(expr.text) ?? null);
    }
    default:
      return null;
  }
}

/** The operands of a `+` chain, left to right; null when another operator is involved. */
function concatParts(expr: Node): Node[] | null {
  if (expr.type !== "additive_expression" && expr.type !== "binary_expression") return [expr];
  const op = expr.children.find((c) => !c.isNamed)?.text;
  if (op !== "+") return null;
  const [left, right] = expr.namedChildren.filter((c) => c.type !== "comment");
  if (!left || !right) return null;
  const l = concatParts(left);
  const r = concatParts(right);
  return l && r ? [...l, ...r] : null;
}

/**
 * The initializer of the last `val`/local named `name` declared before `at`
 * in the enclosing function (lambdas included: a request built inside
 * `client.newCall(…).use { }` reads a URL declared outside it).
 */
function localInitializer(at: Node, name: string): Node | null {
  let fn: Node | null = at.parent;
  while (fn && !/^(?:method_declaration|constructor_declaration|function_declaration|anonymous_initializer|secondary_constructor)$/.test(fn.type)) fn = fn.parent;
  if (!fn) return null;
  let found: Node | null = null;
  const scan = (n: Node): void => {
    if (n.startIndex >= at.startIndex) return;
    if (n.type === "property_declaration" && kotlinNameAndType(n).name === name) found = initializerAfterEquals(n) ?? found;
    else if (n.type === "variable_declarator" && n.childForFieldName("name")?.text === name) found = n.childForFieldName("value") ?? found;
    for (const c of n.children) scan(c);
  };
  scan(fn);
  return found;
}

/**
 * A Java/Kotlin string literal's text with Kotlin template entries as `${…}`
 * holes (`$id` → `${id}`), unless `fill` knows the identifier's value; Java
 * has no templates, so its `$` is literal.
 */
function renderStringLiteral(node: Node, fill: (name: string) => string | null = () => null): string {
  if (!node.namedChildren.some((c) => c.type === "interpolated_identifier" || c.type === "interpolated_expression")) {
    return node.text.replace(/^(?:"""|")|(?:"""|")$/g, "");
  }
  let out = "";
  for (const c of node.namedChildren) {
    if (c.type === "interpolated_identifier") {
      const name = c.text.replace(/^\$/, "");
      out += fill(name) ?? "${" + name + "}";
    } else if (c.type === "interpolated_expression" && c.namedChildren.length === 1 && c.namedChildren[0]!.type === "simple_identifier") {
      const name = c.namedChildren[0]!.text;
      out += fill(name) ?? "${" + name + "}";
    } else if (c.type === "interpolated_expression") out += "${" + c.text.replace(/^\$\{|\}$/g, "").trim() + "}";
    else if (c.type === "escape_sequence" || c.type === "character_escape") out += c.text.slice(1);
    else out += c.text;
  }
  return out;
}

/**
 * The verb of the request chain a builder step belongs to: `.post(body)`,
 * `.method("PUT", …)`, else GET — set before the URL step or after it.
 */
function requestChainVerb(node: Node, receiver: string): string {
  let top = node;
  while (top.parent && /^(?:method_invocation|navigation_expression|navigation_suffix|call_expression|call_suffix)$/.test(top.parent.type)) top = top.parent;
  const after = receiver + "\n" + top.text.slice(node.endIndex - top.startIndex);
  const verb = /\.\s*(post|put|delete|patch|head)\s*\(/i.exec(after)?.[1] ?? /\.\s*method\s*\(\s*"(\w+)"/.exec(after)?.[1];
  const builtVerb = /\.\s*(POST|PUT|DELETE|GET)\s*\(/.exec(after)?.[1];
  return (verb ?? builtVerb ?? "GET").toUpperCase();
}

/** The calls that send a Spring `WebClient` / `RestClient` request built by a fluent chain. */
const SPRING_FLUENT_SENDS = new Set(["retrieve", "exchange", "exchangeToMono", "exchangeToFlux"]);
const FLUENT_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
/** Apache HttpClient request classes (4.x `org.apache.http.client.methods`, 5.x `classic.methods`). */
const APACHE_REQUEST_RE = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/;
/** Apache HttpClient 5 request builders: `ClassicRequestBuilder.get(url)`, `SimpleRequestBuilder.post(url)`. */
const APACHE_BUILDER_RE = /(?:^|\.)(?:Classic|Simple)?RequestBuilder$/;
/** What a request URL looks like once rendered: absolute, an app path, or a path behind an unknown base. */
const REQUEST_URL_RE = /^(?:https?:\/\/|\/|(?:\$\{[^{}]*\})+\/)/;

/**
 * The calls of a fluent chain from `start` down to its root, outermost first
 * (`web.get().uri(x).retrieve()` from `retrieve`'s receiver: uri, get), and
 * the root expression the chain starts from (`web`).
 */
function fluentChain(start: Node | null): { calls: Array<{ name: string; args: Node[]; receiver: string }>; root: Node | null } {
  const calls: Array<{ name: string; args: Node[]; receiver: string }> = [];
  let cur = start;
  for (let i = 0; cur && i < 24 && (cur.type === "method_invocation" || cur.type === "call_expression"); i++) {
    const parts = resolveCall(cur);
    if (!parts) break;
    calls.push({ name: parts.method, args: callArguments(cur), receiver: parts.receiver });
    cur = receiverNode(cur);
  }
  return { calls, root: cur };
}

/**
 * The value a field or property of the file is given: its declaration's
 * initializer, else an assignment to it (`this.web = builder.baseUrl(x).build()`).
 */
function memberInitializer(at: Node, name: string): Node | null {
  let found: Node | null = null;
  const scan = (n: Node): void => {
    if (found) return;
    if (n.type === "variable_declarator" && n.parent?.type === "field_declaration" && n.childForFieldName("name")?.text === name) found = n.childForFieldName("value");
    else if (n.type === "property_declaration" && kotlinNameAndType(n).name === name) found = initializerAfterEquals(n);
    else if (n.type === "assignment_expression" && n.childForFieldName("left")?.text.replace(/^this\./, "") === name) found = n.childForFieldName("right");
    for (const c of n.children) scan(c);
  };
  scan(at.tree.rootNode);
  return found;
}

/**
 * The base address a Spring client chain names: `WebClient.builder().baseUrl(x)`,
 * `RestClient.builder().baseUrl(x)`, `WebClient.create(x)` / `RestClient.create(x)`.
 * Undefined when the chain does not build a client; null when it builds one without a base.
 */
function springClientBase(calls: ReadonlyArray<{ name: string; args: Node[]; receiver: string }>): Node | null | undefined {
  const based = calls.find((c) => c.name === "baseUrl" && c.args.length === 1);
  if (based) return based.args[0]!;
  const created = calls.find((c) => c.name === "create" && /(?:^|\.)(?:WebClient|RestClient)$/.test(c.receiver.trim()));
  if (created) return created.args[0] ?? null;
  return calls.some((c) => c.name === "builder" && /(?:^|\.)(?:WebClient|RestClient)$/.test(c.receiver.trim())) ? null : undefined;
}

/** The path a `.uri(…)` argument names: a URL expression, or the `path(…)` an `uriBuilder ->` lambda sets. */
function fluentUriPath(arg: Node | undefined, at: Node): string | null {
  if (!arg) return null;
  if (/lambda/.test(arg.type)) {
    let path: Node | null = null;
    const scan = (n: Node): void => {
      if (path) return;
      if (n.type === "method_invocation" || n.type === "call_expression") {
        const parts = resolveCall(n);
        if (parts?.method === "path" && parts.firstArg) path = parts.firstArg;
      }
      for (const c of n.children) scan(c);
    };
    scan(arg);
    return path ? urlExpression(path, at, 0) : null;
  }
  return urlExpression(arg, at, 0);
}

/** `new HttpGet(url)` / Kotlin `HttpGet(url)` / `ClassicRequestBuilder.get(url)`, in place or in a local: its verb and URL. */
function apacheRequest(arg: Node, at: Node): { verb: string; target: string | null } | null {
  const expr = /^(?:identifier|simple_identifier)$/.test(arg.type) ? localInitializer(at, arg.text) : arg;
  if (!expr) return null;
  let verb: string | undefined;
  let url: Node | null = null;
  if (expr.type === "object_creation_expression") {
    verb = APACHE_REQUEST_RE.exec(simpleTypeName(expr.childForFieldName("type")?.text) ?? "")?.[1];
    url = firstJavaArg(expr.childForFieldName("arguments"));
  } else if (expr.type === "method_invocation" || expr.type === "call_expression") {
    const own = resolveCall(expr);
    if (own && !own.receiver) {
      verb = APACHE_REQUEST_RE.exec(own.method)?.[1];
      url = own.firstArg;
    } else {
      const { calls } = fluentChain(expr);
      const built = calls.find((c) => FLUENT_VERBS.has(c.name) && APACHE_BUILDER_RE.test(c.receiver.trim()));
      verb = built?.name;
      url = built?.args[0] ?? null;
    }
  }
  if (!verb) return null;
  const rendered = url ? urlExpression(url, at, 0) : null;
  return { verb: verb.toUpperCase(), target: rendered && REQUEST_URL_RE.test(rendered) ? rendered : null };
}

/** A jOOQ-style table reference: an ALL-CAPS generated constant (`STUDENT`, `US2000JOB`). */
const TABLE_CONST_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * A DAO/Repository-shaped receiver carries the entity in its NAME
 * (`caseDAO` → Case, `reimbursementSupportActivityDAO` → …). The DAO layer
 * hides the actual jOOQ behind a factory-built instance, so the data access has
 * to be recognised at the CALL site (`caseDAO.get(id)`) — otherwise a service
 * method's trace never reaches the table it touches through the DAO.
 */
const DAO_RECEIVER_RE = /^(.+?)(DAO|Dao|Repository|Repo)$/;

/**
 * The same DAO/Repository marker as a PREFIX — codebases that name repositories
 * `RepositoryClass` / fields `repositoryClass` instead of `ClassRepository`.
 * Whole words only (no bare `repo…`: `repoPath`, `repoUrl` are VCS vocabulary),
 * and a base naming a collaborator role rather than a record is vetoed —
 * `daoFactory` / `repositoryService` are not data access on "Factory"/"Service",
 * nor is a Maven resolver's `RepositorySystem` on "System".
 */
const DAO_PREFIX_RE = /^(?:Repository|repository|DAO|Dao|dao)([A-Z]\w*)$/;
/** Declared receiver type that is a service-layer collaborator, not a data store. */
const SERVICE_LAYER_TYPE_RE = /(Service|ServiceImpl|Controller|Facade|Handler|Resource|Client|Api|Gateway|Manager|Helper|Component|Action)$/;
const DAO_PREFIX_ROLE_VETO =
  /(Factory|Service|Manager|Provider|Helper|Registry|Impl|Client|Utils?|Url|Uri|Path|Name|Dir|Root|System|Session|Connection|Layout|Context|Config|Configuration|Builder|Listener|Exception)$/;

/** Verb that begins a DAO/Repository data operation (`get`, `findBy…`, `save`, `deleteAll`, …). */
const DAO_CRUD_RE =
  /^(get|find|fetch|load|list|search|read|select|query|save|store|insert|create|add|update|merge|upsert|persist|delete|remove|count|exists|all)/i;

// ─── Message queues (Spring AMQP / Kafka / JMS) ──────────────────────────────
// Publish side: the template verbs are generic (`send`), so they're gated on a
// messaging-template receiver. The first argument is the destination —
// exchange or routing key for RabbitTemplate, topic for KafkaTemplate.
const MQ_TEMPLATE_PUBLISH = new Set([
  "convertAndSend", "convertSendAndReceive", "send", "sendAndReceive",
]);
const MQ_TEMPLATE_RECEIVER_RE = /rabbitTemplate|amqpTemplate|kafkaTemplate|jmsTemplate/i;
/** The template types themselves (`JmsTemplate`, `KafkaTemplate<String, Match>`, `RabbitOperations`), qualified or not. */
const MQ_TEMPLATE_TYPE_RE = /^(?:[\w.]+\.)?(?:RabbitTemplate|AmqpTemplate|RabbitOperations|AmqpOperations|RabbitMessagingTemplate|KafkaTemplate|KafkaOperations|ReactiveKafkaProducerTemplate|JmsTemplate|JmsOperations|JmsMessagingTemplate)(?:<.*>)?$/;

// Consume side: listener annotations. Destination attribute per flavor:
// @RabbitListener(queues = "q"), @KafkaListener(topics = {"t1","t2"}),
// @JmsListener(destination = "d"). Kotlin writes arrays as ["t"].
const MQ_LISTENER_RE = /@(RabbitListener|KafkaListener|JmsListener)\b/;
const MQ_LISTENER_DEST_RE = /(?:queues|topics|destination|queueNames)\s*=\s*[[{]?\s*"([^"]+)"/;
const MQ_LISTENER_REF_RE = /(?:queues|topics|destination|queueNames)\s*=\s*[[{]?\s*([A-Z]\w*(?:\.[A-Za-z_]\w*)*\.[A-Z][A-Z0-9_]*|[A-Z][A-Z0-9_]*)\s*[,)\]}]/;

// ─── Typed application/domain events ─────────────────────────────────────────
// Frameworks that route messages by EVENT TYPE rather than a named queue:
// Spring application events (@EventListener/@TransactionalEventListener +
// publisher.publishEvent), Guava EventBus (@Subscribe + bus.post), Axon
// (@EventHandler), and typed event-bus handlers (@MessageHandler). The
// event's simple type name is the destination — it's the join key that pairs
// a publisher with its handlers.
const EVENT_LISTENER_ANN_RE =
  /@(EventListener|TransactionalEventListener|MessageHandler|Subscribe|EventHandler)\b/;
// `@EventListener(SourceIngestedEvent.class)` — type named in the annotation.
const EVENT_ANN_CLASS_RE = /\(\s*(?:value\s*=\s*)?(?:classes\s*=\s*)?[[{]?\s*([A-Za-z_][\w.]*)\.class/;
// Publish verbs, gated on a publisher/bus-shaped receiver (except
// `publishEvent`, which is unambiguous on its own).
const EVENT_PUBLISH_METHODS = new Set(["publishEvent", "publish", "send", "post", "emit"]);
const EVENT_PUBLISHER_RECEIVER_RE = /(publisher|eventbus|bus)$/i;
// An event payload type: `ClubCreatedEvent`, `KickoffMessage`, a request a
// service sends on the bus and its reply (`ReleasePlayerRequest`, `…Response`) … The
// suffix fence keeps `emailPublisher.send(new Attachment())` from reading as an event.
export const EVENT_TYPE_RE = /(Event|Message|Command|Notification|Request|Response|Reply)$/;
/**
 * The container's own lifecycle events (`@EventListener(ApplicationReadyEvent.class)`, a Micronaut
 * `StartupEvent`): a hook run at startup or shutdown, not a message any code of the project publishes.
 */
const LIFECYCLE_EVENT_RE =
  /^(?:Application(?:Ready|Started|Starting|Prepared|Failed|EnvironmentPrepared|ContextInitialized)Event|Context(?:Refreshed|Started|Stopped|Closed)Event|(?:Servlet|Reactive)?WebServerInitializedEvent|AvailabilityChangeEvent|(?:Server)?(?:Startup|Shutdown)Event)$/;
/** Base payload types, which say nothing about the event: protobuf's `Message`, Spring's `ApplicationEvent`. */
export const GENERIC_EVENT_TYPE_RE = /^(?:Message|MessageLite|AbstractMessage|GeneratedMessage(?:V3)?|Event|ApplicationEvent|BaseEvent|DomainEvent|Command|Notification)$/;

// ─── Outbound HTTP declared via annotations ──────────────────────────────────
// Retrofit interface methods carry the outbound URL in the verb annotation
// itself: `@GET("users/{id}")`. JAX-RS uses the same names but as argument-less
// markers (the path lives in a separate @Path), so requiring the string
// argument is what keeps server resources from reading as outbound calls.
const RETROFIT_ANN_RE = /^@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/;
// Feign (Spring Cloud) client interfaces reuse Spring's mapping annotations
// for OUTBOUND calls — only honored in files that carry @FeignClient.
const FEIGN_MAPPING_RE = /^@(Get|Post|Put|Patch|Delete)Mapping\s*\(/;
const ANN_PATH_RE = /(?:value|path)\s*=\s*[[{]?\s*"([^"]*)"|\(\s*[[{]?\s*"([^"]*)"/;

/** The url an `@HttpExchange` / `@GetExchange` annotation names: positional, `value =` or `url =`. */
function exchangePath(annotation: string): string {
  return /\(\s*"([^"]*)"/.exec(annotation)?.[1] ?? /\b(?:value|url)\s*=\s*"([^"]*)"/.exec(annotation)?.[1] ?? "";
}

/** The interface-level `@HttpExchange` of a Spring HTTP interface: its url and the interface's name. */
function httpExchangeInterface(text: string): { base: string; iface: string | null } {
  const m = /@HttpExchange\b(\s*\([^)]*\))?\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:(?:public|internal|private|sealed|fun)\s+)*interface\s+(\w+)/.exec(text);
  const iface = m?.[2] ?? /\binterface\s+(\w+)/.exec(text)?.[1] ?? null;
  return { base: m?.[1] ? exchangePath(m[1]) : "", iface };
}

/** An `@HttpExchange` base (absolute or a path) joined with a method's url. */
function joinExchange(base: string, path: string): string {
  const origin = /^(https?:\/\/[^/]+)(.*)$/i.exec(base);
  return origin ? origin[1]! + joinUrl(origin[2]!, path).replace(/^\/$/, "") : joinUrl(base, path);
}

/**
 * Where a `@FeignClient(…)` sends: `url = "http://…"` as written, `url = "${league.url}"` the property
 * (its default kept as the fallback), else the service `name` / `value` / `serviceId` / positional name
 * that discovery resolves. Null when none is written out.
 */
function feignBaseRef(args: string): CallBaseRef | null {
  const url = /\burl\s*=\s*"([^"]+)"/.exec(args)?.[1];
  if (url) {
    if (/^https?:\/\//i.test(url)) return { kind: "literal", key: url };
    const prop = /^\$\{([\w.-]+)(?::(.*))?\}$/.exec(url);
    if (prop) return { kind: "config", key: prop[1]!, ...(prop[2] && /^https?:\/\//i.test(prop[2]) ? { fallback: prop[2] } : {}) };
    return null;
  }
  const name = /\b(?:name|value|serviceId)\s*=\s*"([^"]+)"/.exec(args)?.[1] ?? /^\s*"([^"]+)"/.exec(args)?.[1];
  return name && /^[A-Za-z][\w.-]*$/.test(name) ? { kind: "service", key: name } : null;
}

/** Join an optional client base path with a call path, with one leading `/`. */
function joinUrl(base: string | null, path: string): string {
  const parts = [base ?? "", path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + parts.join("/");
}

/** Dependency-injection annotations: `@Autowired`, `@Inject`, `@Value("${x}")`, qualified or with a Kotlin use-site target. */
const VALUE_ANNOTATION_RE = /^@(?:\w+:)?(?:[\w.]+\.)?Value(?![\w.])/;

export class JavaKotlinDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  /**
   * file-local jOOQ table aliases: `private val TABLE = DSL.table("X")` /
   * `val em = Tables.EXTERNALMESSAGE` → `{ TABLE: "X", em: "EXTERNALMESSAGE" }`.
   * Rebuilt per file (each worker owns its extractor and runs `extract` to
   * completion before the next file, so a per-instance field is safe).
   */
  private tableAliases = new Map<string, string>();
  /** The file's string constants by name (`EXISTS = "select … from …"`): a query handed over by name. */
  private stringConsts = new Map<string, string>();

  /** File declares a Feign client — its mapping annotations are outbound calls. */
  private isFeignFile = false;
  /** `@FeignClient(path = "/api/users")` prefix, prepended to method paths. */
  private feignBasePath: string | null = null;
  /** Where a Feign client's calls go: its `url` (literal or a property), else the service `name` discovery resolves. */
  private feignBase: CallBaseRef | null = null;
  /**
   * File references jOOQ (org.jooq import or generated-tables package). The
   * jOOQ table branch only runs here — its generic verbs otherwise misread
   * `String.join(SOME_CONSTANT, …)` as a query on table SOME_CONSTANT.
   */
  private isJooqFile = false;
  /** File imports Room: a SQL-less `@Insert`/`@Update`/`@Delete` writes its parameter's entity. */
  private isRoomFile = false;
  /**
   * Declared field/constructor-parameter types (`clubJpaRepository` →
   * `ClubJpaRepository`). The TYPE names the entity more reliably than the
   * field name: `licenceIdJpaRepository` is a ClubLicenceJpaRepository.
   */
  private fieldTypes = new Map<string, string>();
  /** The file uses the plain Kafka client (`KafkaConsumer`, `KafkaProducer`). */
  private isKafkaClientFile = false;
  private topicDefaults = new Map<string, string>();
  /** Fields and parameters `@Value` fills: the configuration key each holds. */
  private configFields = new Map<string, { key: string; fallback?: string }>();
  /**
   * QueryDSL's generated query types the file names by a static import
   * (`import static ….QPlayer.player;` → `player` → Player); null when the file uses no QueryDSL.
   */
  private querydslPaths: Map<string, string> | null = null;
  /** The file imports Hibernate Search. */
  private isHibernateSearchFile = false;
  /** The file imports Keycloak's `SimpleHttp`. */
  private isKeycloakHttpFile = false;
  /** The file imports CXF's JAX-RS `WebClient`. */
  private isCxfWebClientFile = false;
  /**
   * A Spring HTTP interface (`@HttpExchange`): its methods' `@GetExchange("/x")`
   * are outbound calls, under the interface's own `@HttpExchange` url; null otherwise.
   */
  private httpExchange: { base: string; iface: string | null } | null = null;

  /** A request whose URL starts with a field `@Value` fills is based on that configuration key. */
  protected override ds(info: Parameters<DataSourceExtractor["ds"]>[0]): DataSourceInfo {
    const out = super.ds(info);
    const base = out.kind === "api-call" && !out.baseRef ? /^\$\{(?:this\.)?(\w+)\}/.exec(out.target ?? "")?.[1] : undefined;
    const config = base ? this.configFields.get(base) : undefined;
    if (config) out.baseRef = { kind: "config", key: config.key, ...(config.fallback && /^https?:\/\//.test(config.fallback) ? { fallback: config.fallback } : {}) };
    return out;
  }

  /** Records and enums the file declares: values, never a repository. */
  private ownValueTypes = new Set<string>();

  override beginFile(tree: Tree): void {
    const prepass = buildFilePrepass(tree.rootNode);
    this.ownValueTypes = new Set(
      /\b(?:record|enum)\s+[A-Z]/.test(tree.rootNode.text)
        ? tree.rootNode.descendantsOfType(["record_declaration", "enum_declaration"]).map((d) => d?.childForFieldName("name")?.text ?? "").filter(Boolean)
        : [],
    );
    this.tableAliases = prepass.tableAliases;
    this.stringConsts = prepass.stringConsts;
    fileStringConsts = prepass.stringConsts;
    this.fieldTypes = prepass.fieldTypes;
    this.configFields = prepass.configFields;
    const text = tree.rootNode.text;
    this.isFeignFile = text.includes("@FeignClient");
    const feignArgs = this.isFeignFile ? (text.match(/@FeignClient\s*\(([^)]*)\)/)?.[1] ?? "") : "";
    this.feignBasePath = this.isFeignFile ? (feignArgs.match(/path\s*=\s*"([^"]+)"/)?.[1] ?? null) : null;
    this.feignBase = this.isFeignFile ? feignBaseRef(feignArgs) : null;
    this.isJooqFile = /jooq/i.test(text);
    this.isRoomFile = /\bandroidx\.room\b/.test(text);
    this.isKafkaClientFile = /\borg\.apache\.kafka\.clients\b/.test(text);
    this.isHibernateSearchFile = /\borg\.hibernate\.search\b/.test(text);
    this.isKeycloakHttpFile = /\borg\.keycloak\.[\w.]*\bSimpleHttp\b/.test(text);
    this.isCxfWebClientFile = /\borg\.apache\.cxf\.jaxrs\.client\.(?:WebClient|\*)/.test(text);
    this.httpExchange = /@(?:Http|Get|Post|Put|Patch|Delete)Exchange\b/.test(text) && /\binterface\s+\w/.test(text) ? httpExchangeInterface(text) : null;
    this.querydslPaths = /\bcom\.querydsl\b/.test(text)
      ? new Map([...text.matchAll(/^\s*import\s+static\s+[\w.]*\.Q([A-Z]\w*)\.(\w+)\s*;?\s*$/gm)].map((m) => [m[2]!, m[1]!]))
      : null;
    // Topics a file names by a variable read from the environment with a default
    // (`val topic = System.getenv("TOPIC") ?: "orders"`): the default.
    this.topicDefaults = new Map([...text.matchAll(/\b(?:val|var|String)\s+(\w+)\s*(?::\s*String\??\s*)?=\s*[^\n;]*?(?:\?:|\?\s*\S+\s*:)\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  }

  /** The one entity the file's query constants named in `expr` read, with the access the queries agree on. */
  private constantsQueryTarget(expr: Node): { entity: string; access?: "read" | "write" } | null {
    const targets = expr.descendantsOfType("identifier")
      .map((id) => (id ? this.stringConsts.get(id.text) : undefined))
      .map((text) => (text ? constantQueryTarget(text) : null))
      .filter((t): t is { entity: string; access?: "read" | "write" } => t !== null);
    const entities = new Set(targets.map((t) => t.entity));
    const accesses = new Set(targets.map((t) => t.access));
    return entities.size === 1 ? { entity: targets[0]!.entity, ...(accesses.size === 1 && targets[0]!.access ? { access: targets[0]!.access } : {}) } : null;
  }

  /** A String method whose every return hands over the file's query constants of one entity. */
  private builderQueryRow(method: Node): DataSourceInfo | null {
    const body = method.childForFieldName("body");
    if (!body) return null;
    const returns = body.descendantsOfType("return_statement").filter((r): r is Node => !!r && !insideNestedCallable(r, body));
    if (returns.length === 0) return null;
    const hits = returns.map((r) => (r.namedChild(0) ? this.constantsQueryTarget(r.namedChild(0)!) : null));
    if (hits.some((h) => !h) || new Set(hits.map((h) => h!.entity)).size !== 1) return null;
    const hit = hits[0]!;
    return this.ds({
      kind: "database",
      name: `query: ${method.childForFieldName("name")?.text ?? "?"}`,
      target: hit.entity,
      entity: hit.entity,
      line: returns[0]!.startPosition.row + 1,
      ...withAccess(hit.access ?? "read"),
    });
  }

  /** `XDescriptorFactory.create(Match.class, FETCH_MATCHES, "m")`: a JPQL constant handed to a descriptor or query factory. */
  private factoryQueryRow(call: Node): DataSourceInfo | null {
    const name = call.childForFieldName("name")?.text ?? "";
    const object = call.childForFieldName("object")?.text ?? "";
    if (!/descriptor|jpql/i.test(object) || /^(?:createQuery|createNamedQuery|createNativeQuery)$/.test(name)) return null;
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => a?.type === "identifier") ?? [];
    for (const arg of args) {
      const text = this.stringConsts.get(arg.text);
      const hit = text ? constantQueryTarget(text) : null;
      if (hit) {
        return this.ds({ kind: "database", name: `${object.split(".").pop()}.${name}`, target: hit.entity, entity: hit.entity, line: call.startPosition.row + 1, ...withAccess(hit.access ?? "read") });
      }
    }
    return null;
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "method_invocation" || node.type === "call_expression") {
      const call = resolveCall(node);
      if (call) this.classifyCall(node, call, sources);
    }

    // A query builder: a method returning a String built from the file's JPQL
    // constants (`return withFilter(FIND_FIXTURES, ids)`) hands that query to
    // whoever runs it — the entity it names is what a call of the method reads.
    if (node.type === "method_declaration" && node.childForFieldName("type")?.text === "String" && this.stringConsts.size > 0) {
      const row = this.builderQueryRow(node);
      if (row) sources.push(row);
    }
    // A JPQL constant handed to a descriptor factory (`ListDescriptorFactory.create(Match.class, FETCH_MATCHES, "m")`).
    if (node.type === "method_invocation" && this.stringConsts.size > 0) {
      const row = this.factoryQueryRow(node);
      if (row) sources.push(row);
    }

    // A JPQL query handed to a constructor — a framework's list or grid
    // descriptor (`new FixtureListDescriptor<>(Match.class, "select m from Match m")`)
    // runs it later; the query names the entity it reads.
    if (node.type === "object_creation_expression") {
      const entity = constructorJpqlEntity(node);
      if (entity) {
        const type = simpleTypeName(node.childForFieldName("type")?.text) ?? "query";
        sources.push(this.ds({ kind: "database", name: `new ${type}`, target: entity, entity, line: node.startPosition.row + 1, ...withAccess("read") }));
      }
    }

    // `class X implements ApplicationListener<MatchFinishedEvent>`: Spring hands it every such
    // event — its `onApplicationEvent` is the consume side, as an `@EventListener` method is.
    if (node.type === "class_declaration") {
      const event = /\bApplicationListener\s*<\s*([\w.]+)/.exec(node.childForFieldName("interfaces")?.text ?? "")?.[1]?.split(".").pop();
      const handler = event ? node.childForFieldName("body")?.namedChildren.find((m) => m.type === "method_declaration" && m.childForFieldName("name")?.text === "onApplicationEvent") : undefined;
      if (event && handler && !LIFECYCLE_EVENT_RE.test(event)) {
        sources.push(this.ds({ kind: "queue-consume", name: "ApplicationListener", target: event, line: (handler.childForFieldName("name") ?? handler).startPosition.row + 1 }));
      }
    }

    // `@Value` injects configuration. (`@Autowired` / `@Inject` mark an injection point, which
    // the parameter and field types and the container's bindings already state — not data.)
    if (node.type === "annotation" || node.type === "marker_annotation") {
      const text = node.text;
      // By the annotation's NAME (`@field:Value`): a substring test read
      // `@RequestParam(defaultValue = "x")` and `@JsonValue` as injections.
      if (VALUE_ANNOTATION_RE.test(text)) {
        // `@Value("${league.season:2024}")` reads configuration — the key, its default dropped.
        const configKey = /Value\s*\(\s*(?:value\s*=\s*)?"\$\{([^}:]+)/.exec(text)?.[1]?.trim();
        sources.push(this.ds({
          kind: "env",
          name: text.replace(/^@/, ""),
          target: configKey ?? null,
          line: node.startPosition.row + 1,
        }));
      }

      // Listener annotations mark the consume side of a message flow:
      // the annotated method is the broker's entry point into this file.
      const listener = text.match(MQ_LISTENER_RE);
      if (listener) {
        // `topics = Topics.CLUB_EVENTS`: another class's constant, which the project pass reads.
        const ref = text.match(MQ_LISTENER_DEST_RE) ? undefined : MQ_LISTENER_REF_RE.exec(text)?.[1];
        sources.push(this.ds({
          kind: "queue-consume",
          name: `@${listener[1]}`,
          target: text.match(MQ_LISTENER_DEST_RE)?.[1] ?? ref ?? null,
          ...(ref ? { targetRef: ref } : {}),
          line: node.startPosition.row + 1,
        }));
      }

      // Typed-event handlers: the subscribed event type is the destination —
      // named in the annotation (`@EventListener(X.class)`) or the handler's
      // event-shaped parameter (`handle(XEvent event, Metadata md)`,
      // `handle(Audit audit, XResponse response)`), else its first.
      const evtListener = text.match(EVENT_LISTENER_ANN_RE);
      if (evtListener && !listener) {
        const annClass = text.match(EVENT_ANN_CLASS_RE)?.[1]?.split(".").pop();
        const target = annClass ?? handlerFirstParamType(node);
        if (target && !LIFECYCLE_EVENT_RE.test(target)) {
          sources.push(this.ds({
            kind: "queue-consume",
            name: `@${evtListener[1]}`,
            target,
            line: node.startPosition.row + 1,
          }));
        }
      }

      // A repository method whose SQL is its annotation — Spring Data / Room
      // `@Query("SELECT … FROM users")`, `@NativeQuery`, JDBI `@SqlQuery` /
      // `@SqlUpdate`, MyBatis `@Select`/`@Insert`/…: the statement names the
      // table (JPQL names the entity, which is what the ER model calls it).
      // Room's SQL-less `@Insert fun add(user: User)` writes its parameter's.
      // Spring Data `@Procedure("usp_Sign")` / `@Procedure(procedureName = "usp_Sign")`: the method runs that routine.
      const proc = /^@Procedure\s*\(\s*(?:(?:procedureName|value)\s*=\s*)?"([^"]+)"/.exec(text);
      const procHolder = proc ? (node.parent?.type === "modifiers" ? node.parent.parent : node.parent) : null;
      if (proc && procHolder && /^(?:method_declaration|function_declaration)$/.test(procHolder.type)) {
        const nameNode = procHolder.childForFieldName("name") ?? procHolder.children.find((c) => c.type === "simple_identifier") ?? procHolder;
        sources.push(this.ds({ kind: "database", name: "@Procedure", target: proc[1]!, routine: true, line: nameNode.startPosition.row + 1 }));
      }

      const sqlAnn = text.match(SQL_ANNOTATION_RE);
      if (sqlAnn) {
        const access = annotatedSqlAccess(node, text, sqlAnn[1]!, this.isRoomFile);
        if (access) {
          sources.push(this.ds({
            kind: "database",
            name: `@${sqlAnn[1]}`,
            target: access.table,
            entity: access.table,
            line: access.line,
            ...(access.access ? { access: access.access } : {}),
          }));
        }
      }

      // Retrofit: the verb annotation IS the outbound call declaration. The
      // path is emitted app-relative so the cross-tier route linker can join
      // it to the serving backend route.
      const retrofit = text.match(RETROFIT_ANN_RE);
      if (retrofit) {
        // The interface declaring it is the client: its base is the one the Retrofit builder creating it names.
        let holder: typeof node | null = node.parent;
        while (holder && holder.type !== "interface_declaration" && holder.type !== "class_declaration") holder = holder.parent;
        const iface = holder ? (holder.childForFieldName("name") ?? holder.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier"))?.text : undefined;
        sources.push(this.ds({
          kind: "api-call",
          name: retrofit[1]!,
          target: joinUrl(null, retrofit[2]!),
          line: node.startPosition.row + 1,
          ...(iface ? { baseRef: { kind: "client" as const, key: iface } } : {}),
        }));
      }

      // Spring HTTP interface methods: `@GetExchange("/{id}")`, `@HttpExchange(method = "GET", url = "/x")`.
      if (this.httpExchange) {
        const exchange = /^@(Get|Post|Put|Patch|Delete)Exchange\b/.exec(text);
        const holder = node.parent?.type === "modifiers" ? node.parent.parent : node.parent;
        const onMethod = !!holder && /^(?:method_declaration|function_declaration)$/.test(holder.type);
        const generic = !exchange && onMethod && /^@HttpExchange\b/.test(text) ? /\bmethod\s*=\s*"(\w+)"/.exec(text)?.[1] : undefined;
        const verb = exchange?.[1] ?? generic;
        if (verb && onMethod) {
          const target = joinExchange(this.httpExchange.base, exchangePath(text));
          sources.push(this.ds({
            kind: "api-call",
            name: verb.toUpperCase(),
            target,
            line: node.startPosition.row + 1,
            // A relative base is the client's: the adapter the proxy factory is handed states it.
            ...(!/^https?:\/\//i.test(target) && this.httpExchange.iface ? { baseRef: { kind: "client" as const, key: this.httpExchange.iface } } : {}),
          }));
        }
      }

      // Feign client methods: Spring mapping annotations, outbound semantics.
      if (this.isFeignFile) {
        const feign = text.match(FEIGN_MAPPING_RE);
        if (feign) {
          const pm = text.match(ANN_PATH_RE);
          sources.push(this.ds({
            kind: "api-call",
            name: feign[1]!.toUpperCase(),
            target: joinUrl(this.feignBasePath, pm?.[1] ?? pm?.[2] ?? ""),
            line: node.startPosition.row + 1,
            ...(this.feignBase ? { baseRef: this.feignBase } : {}),
          }));
        }
      }
    }
  }

  private classifyCall(node: Node, call: CallParts, sources: DataSourceInfo[]): void {
    const { method, receiver } = call;
    const line = node.startPosition.row + 1;

    // 0) A stored procedure called by name: JDBC `conn.prepareCall("{call usp_Sign(?)}")`, Spring's
    // `new SimpleJdbcCall(ds).withProcedureName("usp_Sign")`, JPA `em.createStoredProcedureQuery("usp_Sign")`.
    if (STORED_ROUTINE_METHODS.has(method) && call.firstArg) {
      const text = /^(?:this\.)?\w+$/.test(call.firstArg.text)
        ? this.stringConsts.get(call.firstArg.text.replace(/^this\./, "")) ?? localStringValue(node, call.firstArg.text, this.stringConsts)
        : stringArgText(call.firstArg, this.stringConsts);
      const routine = text ? routineCalled(text, method !== "prepareCall") : null;
      if (routine) {
        sources.push(this.ds({ kind: "database", name: method, target: routine, routine: true, line }));
        return;
      }
    }

    // 1) jOOQ — table lives in the first argument. Only CONSUME the call when a
    // table is actually found; otherwise fall through, since a verb like
    // `update` is also a DAO method (`documentDAO.update(doc)`) handled below.
    // Gated on file-level jOOQ evidence: `join`/`from` + an ALL-CAPS constant
    // also describes `String.join(NAME_DELIMITER, …)`, which otherwise becomes
    // a phantom table. The receiver veto covers the same shape inside genuine
    // jOOQ files: a Capitalized bare-identifier receiver is a class (`String`,
    // `LocalDate`), never a query chain (`dsl…`, `DSL`, `STUDENT` stay eligible).
    if (this.isJooqFile && JOOQ_TABLE_VERBS.has(method) && !/^[A-Z][a-z]\w*$/.test(receiver.trim()) &&
      (method !== "delete" || isJooqDeleteChain(node, receiver))) {
      const table = resolveTableExpr(call.firstArg, this.tableAliases);
      if (table) {
        sources.push(this.ds({
          kind: "database",
          name: `jOOQ: ${method}`,
          target: table,
          entity: table,
          line,
          ...withAccess(dbAccessFor(method, JOOQ_ACCESS)),
        }));
        return;
      }
    }

    // 1b) QueryDSL — `queryFactory.selectFrom(player)`, `.from(QClub.club)`, `.delete(player)`: the
    // generated `Q` type the argument is names the entity. Only in a file that imports QueryDSL, and
    // only when the argument resolves to a `Q` type, so `stream.from(x)` and `cache.delete(k)` stay out.
    if (this.querydslPaths && QUERYDSL_VERBS.has(method)) {
      const entity = this.querydslEntity(node, call.firstArg);
      if (entity) {
        sources.push(this.ds({ kind: "database", name: `QueryDSL: ${method}`, target: entity, entity, line, ...withAccess(QUERYDSL_WRITES.has(method) ? "write" : "read") }));
        return;
      }
    }
    // `player.id.count()`, `QClub.club.id.max()`: an aggregate over a QueryDSL path, not a repository's count.
    if (this.querydslPaths && this.querydslPathRoot(node, receiver)) return;

    // 1b') Hibernate Search: `fullTextEntityManager.createFullTextQuery(query, Match.class)`, and
    // Hibernate Search 6's `searchSession.search(Match.class)` — a read of the indexed entity.
    if (method === "createFullTextQuery" || (method === "search" && this.isHibernateSearchFile && /session$/i.test(receiverLeaf(receiver)))) {
      const entity = jpaEntityArg(node);
      if (entity) {
        sources.push(this.ds({ kind: "database", name: method, target: entity, entity, line, ...withAccess("read") }));
        return;
      }
    }

    // 1b'') Keycloak `SimpleHttp`: `SimpleHttp.doPost(url, session)`, `http.doGet(url).asJson()` on a
    // `SimpleHttp.create(session)` — the URL is the first argument, the verb the method's.
    if (this.isKeycloakHttpFile && /^do(?:Get|Post|Put|Delete|Patch|Head)$/.test(method)) {
      const leaf = receiverLeaf(receiver);
      const declared = /^[\w$]+$/.test(leaf) ? (localDeclaredType(node, leaf) ?? this.fieldTypes.get(leaf) ?? null) : null;
      if (leaf === "SimpleHttp" || declared === "SimpleHttp" || /\bSimpleHttp\s*\.\s*create\s*\(/.test(receiver)) {
        const arg = call.firstArg;
        const url = arg ? urlExpression(arg, node, 0) ?? (concatParts(arg) ?? [arg]).map((p) => "${" + p.text.replace(/\s+/g, " ") + "}").join("") : null;
        sources.push(this.ds({ kind: "api-call", name: method.slice(2).toUpperCase(), target: url, line }));
        return;
      }
    }

    // 1c) CXF `WebClient`: `client.path("clubs/" + id); client.query("season", s); client.get(Club.class)`
    // sends to the client's base and the paths set on it before the call — or chained into it.
    if (this.isCxfWebClientFile && CXF_SEND_METHODS.has(method)) {
      const request = this.cxfWebClientRequest(node, call);
      if (request) {
        sources.push(this.ds({ kind: "api-call", name: request.verb, target: request.target, line }));
        return;
      }
    }

    // 2) DAO / Repository call — entity from the receiver's declared type when
    // the file declares it (`clubJpaRepository: ClubJpaRepository` →
    // Account), else from the receiver name (`caseDAO.get` → Case). Dominant
    // data path here: the DAO wraps jOOQ behind a factory, so this is where a
    // service method's DB access is visible.
    const named = daoReceiverEntity(receiver, this.fieldTypes);
    // A class literal names the entity outright (`commonDAO.find(Player.class, id)`);
    // a DAO named for no entity (`CommonDAO`, `GenericDao`) handles whatever it is
    // handed, so the instance's declared type is the entity, or none.
    const generic = named !== null && GENERIC_DAO_NAME.test(named);
    const daoEntity = named === null ? null
      : (jpaEntityArg(node) ?? (generic ? this.instanceArgType(node, call.firstArg) : named));
    if (named && DAO_CRUD_RE.test(method)) {
      sources.push(this.ds({
        kind: "database",
        name: `DAO: ${method}`,
        target: daoEntity,
        ...(daoEntity ? { entity: daoEntity } : {}),
        line,
        ...withAccess(jvmVerbAccess(method)),
      }));
      return;
    }

    // 2b) An extension client keyed by the entity class (Halo, Kubernetes
    // operators): `client.fetch(Post.class, name)`, `client.listBy(Post.class, …)`,
    // `client.update(post)`. The entity is the class literal, else the declared
    // type of the object handed over. A receiver declared as an
    // `…ExtensionClient`, or a client-named one given a class literal.
    if (EXTENSION_CLIENT_METHODS.has(method)) {
      const seg = receiver.split(".").pop()?.trim() ?? "";
      const declared = /^[\w$]+$/.test(seg) ? (localDeclaredType(node, seg) ?? this.fieldTypes.get(seg) ?? null) : null;
      const literal = /^[A-Z]\w*(?:\.class|::class(?:\.java)?)$/.test(call.firstArg?.text ?? "") ? call.firstArg!.text.replace(/(?:\.class|::class(?:\.java)?)$/, "") : null;
      if ((declared && /ExtensionClient$/.test(declared)) || (literal && /client$/i.test(seg))) {
        const argName = call.firstArg?.type === "identifier" ? call.firstArg.text : null;
        const entity = literal ?? (argName ? heldEntityType(node, argName) : call.firstArg ? producedEntityType(node, call.firstArg) : null);
        // What another class's method returns (`profile.user()`, `fetcher.getConfigMap().flatMap(cm -> …)`): typed by the project pass.
        const producer = entity || !call.firstArg || !EXTENSION_CLIENT_WRITES.has(method) ? null : objectProducer(node, call.firstArg, (n) => this.fieldTypes.get(n) ?? null);
        sources.push(this.ds({
          kind: "database",
          name: `${seg || "client"}.${method}`,
          target: entity,
          ...(entity ? { entity } : {}),
          ...(producer ? { entityProducer: producer } : {}),
          line,
          ...withAccess(EXTENSION_CLIENT_WRITES.has(method) ? "write" : "read"),
        }));
        return;
      }
    }

    // 3) Spring Data / JPA repository methods.
    // The receiver's declared type is the target when the file declares it
    // (`store.findByEmail` on a `UserStore` field → "UserStore"): whatever the
    // naming convention, the call then lands on a real repository node instead
    // of the shared "(unresolved)" bucket. A service-layer type is no store —
    // `userService.findAll()` in a controller merely shares Spring Data's verbs.
    const jdbc = JDBC_METHODS.has(method) && this.isJdbcReceiver(node, receiver);
    // `session.save(order)` is Hibernate's, read below with its entity.
    if ((SPRING_DATA_EXACT.has(method) || SPRING_DATA_DERIVED.test(method)) && !jdbc) {
      const access = dbAccessFor(method, SPRING_DATA_ACCESS) ?? jvmVerbAccess(method);
      const seg = receiver.split(".").pop()?.trim() ?? "";
      const declared = /^[\w$]+$/.test(seg)
        ? (localDeclaredType(node, seg) ?? this.fieldTypes.get(seg) ?? null)
        : null;
      // A service receiver (`personService.save(cmd)`) is a call into the
      // service layer, where the access — if any — is visible in its own
      // right; a bare `save(x)` / `getByShirtNumber(id)` is a call on this
      // class, which the linker follows to its definition. Neither is a data
      // access here: emitting them put a target-less "database" row on two
      // thirds of one real codebase's service methods.
      // A field inherited from a base class has no declaration here; its name still says service.
      if (!seg || (declared ? SERVICE_LAYER_TYPE_RE.test(declared) : SERVICE_LAYER_NAME_RE.test(seg))) return;
      // `products.count()` on a record of the file (`record Products(int count, …)`): its accessor.
      if (declared && this.ownValueTypes.has(declared)) return;
      // `InetAddress.getByName(host)`, `NetworkInterface.getByIndex(i)`: the JDK's network lookups share the verb.
      if (/^(?:java\.net\.)?(?:Inet[46]?Address|NetworkInterface)$/.test(receiver.trim())) return;
      // A repository is a field or a local: `persons.stream()…count()`, `Projections.count(…)`
      // and `cb.count(…)` are a stream, a static helper and a criteria builder.
      if (SPRING_DATA_EXACT.has(method) && (!/^[a-z_$][\w$]*$/.test(seg) || /^(?:cb|criteriaBuilder|builder|stream)$/i.test(seg))) return;
      sources.push(this.ds({ kind: "database", name: method, target: declared, line, ...withAccess(access) }));
      return;
    }

    // 4) JdbcTemplate / EntityManager — generic names, gated on receiver. The
    // entity is the class literal JPA takes (`find(Person.class, id)`,
    // `createNamedQuery("…", Person.class)`, `createQuery(jpql, Person.class)`)
    // or the `from Person` of a JPQL/HQL string; a criteria query
    // (`createQuery(cq)`) names none.
    if (jdbc) {
      // `em.createNamedQuery("q", X.class).setParameter(…).getResultList()` is ONE access: the
      // `createNamedQuery` row inside the chain carries it, with its entity.
      if (/^(?:getResultList|getSingleResult|list|uniqueResult)$/.test(method) &&
        /\.\s*create(?:Named|Native|SQL)?Query\s*\(|\.\s*getNamedQuery\s*\(|\.\s*createCriteria\s*\(/.test(receiver)) return;
      // A query held in a constant of the file (`session.createSQLQuery(EXISTS)`), or written at the call.
      // …or in a local of the method (`String sql = """ SELECT … """; em.createNativeQuery(sql)`).
      const constant = call.firstArg && /^(?:this\.)?\w+$/.test(call.firstArg.text)
        ? this.stringConsts.get(call.firstArg.text.replace(/^this\./, "")) ?? localStringValue(node, call.firstArg.text, this.stringConsts)
        : call.firstArg ? stringArgText(call.firstArg, this.stringConsts) : null;
      const fromConstant = constant ? constantQueryTarget(constant) : null;
      // `em.createQuery("select new x.ClubRow(c.id) from Club c", ClubRow.class)`: the class literal is the
      // result's shape; the JPQL's `from` names what is read.
      const jpqlEntity = method === "createQuery" && constant ? jpaEntityText(`"${constant}"`) : null;
      const entity = jpqlEntity
        ?? jpaEntityArg(node)
        ?? fromConstant?.entity
        // `TypedQuery<Player> q = em.createQuery(criteria)`: the declared result type names it.
        ?? typedQueryEntity(node)
        // `em.merge(person)`, `session.saveOrUpdate(order)`: the instance's declared type.
        ?? (JPA_INSTANCE_METHODS.has(method) ? this.instanceArgType(node, call.firstArg) : null);
      // `createNamedQuery("match.byClub", Long.class)`: the query is declared on an entity elsewhere.
      const named = /^(?:createNamedQuery|getNamedQuery)$/.test(method) && call.firstArg?.type === "string_literal"
        ? call.firstArg.text.replace(/^"|"$/g, "") : null;
      sources.push(this.ds({
        kind: "database",
        name: method,
        target: entity,
        ...(entity ? { entity } : {}),
        ...(named && !entity ? { namedQuery: named } : {}),
        line,
        ...withAccess(dbAccessFor(method, JDBC_ACCESS) ?? fromConstant?.access),
      }));
      return;
    }

    // 4b) The plain Kafka client: `consumer.subscribe(listOf(topic))` (in a
    // `KafkaConsumer(props).apply { … }` the receiver is implicit) consumes the topic.
    if (this.isKafkaClientFile && method === "subscribe" && (!receiver || /consumer/i.test(receiver))) {
      const args = node.childForFieldName("arguments")?.text ?? node.children.find((c) => c.type === "call_suffix")?.text ?? "";
      const lit = /"([^"]+)"/.exec(args)?.[1];
      const name = /\(\s*(?:listOf|setOf|List\.of|Set\.of|Arrays\.asList|Collections\.singletonList)?\s*\(?\s*([a-z_]\w*)\s*\)/i.exec(args)?.[1];
      const topic = lit ?? (name ? this.topicDefaults.get(name) ?? this.stringConsts.get(name) ?? name : null);
      sources.push(this.ds({ kind: "queue-consume", name: "MQ: Kafka subscribe", target: topic ?? null, line }));
      return;
    }

    // 5) Message-queue publish — rabbitTemplate.convertAndSend(exchange, key,
    // payload) / kafkaTemplate.send(topic, msg). The first argument names the
    // destination; a string literal is unquoted, any other expression's source
    // text is kept as a join label.
    if (MQ_TEMPLATE_PUBLISH.has(method) && this.isMqTemplate(node, receiver)) {
      const ref = constantRef(call.firstArg);
      sources.push(this.ds({
        kind: "queue-publish",
        name: `MQ: ${method}`,
        target: destinationLabel(call.firstArg),
        ...(ref ? { targetRef: ref } : {}),
        line,
      }));
      return;
    }

    // 5a) The plain RabbitMQ client: `channel.basicPublish(exchange, routingKey, props, body)`
    // publishes to the exchange; `channel.basicConsume(queue, …, consumer)` consumes the queue.
    if ((method === "basicPublish" || method === "basicConsume") && this.isAmqpChannel(node, receiver)) {
      sources.push(this.ds({
        kind: method === "basicPublish" ? "queue-publish" : "queue-consume",
        name: `MQ: ${method}`,
        target: destinationLabel(call.firstArg),
        ...(constantRef(call.firstArg) ? { targetRef: constantRef(call.firstArg)! } : {}),
        line,
      }));
      return;
    }

    // 5b) Typed-event publish — `eventPublisher.send(audit, meta, message)` /
    // `springPublisher.publishEvent(new SourceIngestedEvent(x))` /
    // `eventBus.post(event)`. The destination is the event's TYPE, resolved
    // from a `new X(...)` / `X.newBuilder()` argument or the declared type of
    // an identifier argument (rightmost event-shaped argument wins — typed
    // event frameworks put audit/metadata first, payload last).
    if (EVENT_PUBLISH_METHODS.has(method)) {
      const recvLeaf = receiver.split(".").pop()?.trim() ?? "";
      if (method === "publishEvent" || EVENT_PUBLISHER_RECEIVER_RE.test(recvLeaf)) {
        const resolved = this.resolveEventArgs(node, method === "publishEvent");
        // A helper parameter typed as the base message (`emit(…, Message msg)`) says nothing:
        // the project pass types it at the helper's callers instead.
        const events = resolved.every((e) => GENERIC_EVENT_TYPE_RE.test(e)) && payloadParameter(node) !== null ? [] : resolved;
        if (events.length > 0) {
          for (const evt of events) {
            sources.push(this.ds({
              kind: "queue-publish",
              name: `EVT: ${method}`,
              target: evt,
              line,
            }));
          }
          return;
        }
        // The payload is a parameter of a helper nothing here calls with a type (`emit(Entity e, Object event)`):
        // the project pass types it at the helper's callers.
        const payload = payloadParameter(node);
        if (payload !== null) {
          sources.push(this.ds({ kind: "queue-publish", name: `EVT: ${method}`, target: null, payloadParameter: payload, line }));
          return;
        }
      }
    }

    // 6) HTTP client calls. A request URL is read where the request is built
    // — OkHttp `Request.Builder().url("…")`, `HttpRequest.newBuilder(URI.create("…"))`
    // / `.uri(URI.create("…"))` — and its verb from the rest of the chain.
    // `URI.create(url).toURL().openConnection()` / `new URL(url).openConnection()`: java.net's own client.
    // …or `URL url = URI.create(urlString).toURL(); … url.openConnection()`.
    const URL_START_RE = /^(?:URI\.create|new\s+URL|new\s+URI)\s*\(([\s\S]*)\)(?:\.toURL\s*\(\s*\))?$/;
    const urlLocal = method === "openConnection" && /^\w+$/.test(receiver.trim()) ? localInitializer(node, receiver.trim()) : null;
    if (method === "openConnection" && (/\.toURL\s*\(\s*\)$|^new\s+URL\s*\(/.test(receiver.trim()) || (urlLocal && URL_START_RE.test(urlLocal.text.trim())))) {
      const argNode = urlLocal ? urlArgFrom(urlLocal) : URL_START_RE.test(receiver.trim()) ? findUrlArg(node) : null;
      const url = argNode ? urlExpression(argNode, node, 0) : null;
      // A URL the method is handed (`getContent(String urlString)`): its parameter, as a hole each caller fills.
      const param = !url && argNode?.type === "identifier" && enclosingParamNames(node).has(argNode.text) ? `\${${argNode.text}}` : null;
      sources.push(this.ds({ kind: "api-call", name: "GET", target: param ?? (url && /^(?:https?:\/\/|\/|(?:\$\{[^{}]*\})+\/)/.test(url) ? url : null), line }));
      return;
    }
    // Spring `WebClient` / `RestClient`: `web.get().uri("/clubs/{id}", id).retrieve()` sends to the
    // client's base — the `baseUrl(…)` / `create(…)` it was built with — and the uri.
    if (SPRING_FLUENT_SENDS.has(method)) {
      const request = this.springFluentRequest(node);
      if (request) {
        sources.push(this.ds({ kind: "api-call", name: request.target ? request.verb : method, target: request.target, line }));
        return;
      }
    }
    // Apache HttpClient: `client.execute(new HttpDelete(url))`, the request built in place or in a local.
    if (method === "execute" && call.firstArg) {
      const request = apacheRequest(call.firstArg, node);
      if (request) {
        sources.push(this.ds({ kind: "api-call", name: request.target ? request.verb : method, target: request.target, line }));
        return;
      }
    }
    const built = builtRequestUrl(node, call);
    if (built) {
      sources.push(this.ds({ kind: "api-call", name: requestChainVerb(node, call.receiver), target: built.target, line }));
      return;
    }
    // Otherwise only a call that SENDS on a client named as one: a builder's
    // configuration (`OkHttpClient.Builder().connectTimeout(…)`) sends nothing.
    // `request.exchange()` on a ServerRequest is an accessor: a bare exchange/retrieve
    // sends only at the end of a request chain (`webClient.get().uri(…).exchange()`).
    const accessor = (method === "exchange" || method === "retrieve") && callArguments(node).length === 0 && !/\.uri\s*\(|\.(?:get|post|put|patch|delete|method)\s*\(/.test(receiver) && !HTTP_HINT_RE.test(receiver);
    // `WebClient.create(x).get()`: a Spring client's argument-less verb only starts the request its send reads.
    const springSpec = FLUENT_VERBS.has(method) && callArguments(node).length === 0 && /\b(?:WebClient|RestClient)\b/.test(receiver);
    const clientSend = HTTP_SEND_METHODS.has(method) && !springSpec && (HTTP_HINT_RE.test(receiver) ||
      // A client known only by its name: a send of a request, never an argument-less verb that starts a fluent one.
      (CLIENT_NAMED_RE.test(receiver.trim()) && (!FLUENT_VERBS.has(method) || callArguments(node).length > 0) &&
        !REQUEST_BUILDER_RE.test(enclosingBodyText(node))));
    if ((HTTP_METHODS.has(method) && !accessor) || clientSend) {
      // RestTemplate's URL is its first argument: `getForObject(clubsUrl + "/api/clubs/" + id, Club.class)`.
      const url = REST_TEMPLATE_URL_FIRST.has(method) && call.firstArg ? urlExpression(call.firstArg, node, 0) : null;
      const target = url && /^(?:https?:\/\/|\/|(?:\$\{[^{}]*\})+\/)/.test(url) ? url : null;
      const verb = /^(get|post|put|delete|patch)For/.exec(method)?.[1]?.toUpperCase() ?? (method === "exchange" ? exchangeVerb(node) : null);
      sources.push(this.ds({ kind: "api-call", name: target && verb ? verb : method, target, line }));
      return;
    }

    // 7) Environment / config reads.
    if (method === "getProperty" || method === "getenv") {
      // A receiver declared as something else than a configuration holder (a JCR `Node`,
      // a bean) reads its own property, not the environment.
      const leaf = receiverLeaf(receiver);
      const declared = /^[\w$]+$/.test(leaf) ? (localDeclaredType(node, leaf) ?? this.fieldTypes.get(leaf) ?? null) : null;
      if (declared && !/(?:Environment|PropertyResolver|Properties|PropertySource\w*|Config\w*|Configuration|Settings|System|Env)$/.test(declared)) return;
      // The variable (or system property) named: `System.getenv("DATABASE_URL")`.
      const key = /\b(?:getenv|getProperty)\s*\(\s*"([A-Za-z_][\w.-]*)"/.exec(node.text)?.[1] ?? null;
      sources.push(this.ds({ kind: "env", name: method, target: key, line }));
    }
  }

  /** The entity a QueryDSL path argument stands for: `QPlayer.player`, a static import of it, a `QPlayer` local or field. */
  private querydslEntity(node: Node, arg: Node | null): string | null {
    if (!arg) return null;
    const text = arg.text.trim();
    const inline = /^(?:[\w.]*\.)?Q([A-Z]\w*)\.\w+$/.exec(text) ?? /^new\s+(?:[\w.]*\.)?Q([A-Z]\w*)\s*\(/.exec(text);
    if (inline) return inline[1]!;
    if (!/^[a-z_$][\w$]*$/.test(text)) return null;
    const declared = localDeclaredType(node, text) ?? this.fieldTypes.get(text) ?? null;
    const fromType = declared ? /^Q([A-Z]\w*)$/.exec(declared)?.[1] : undefined;
    return fromType ?? this.querydslPaths?.get(text) ?? null;
  }

  /** The receiver starts from a QueryDSL path (`player.id`, `QClub.club.name`). */
  private querydslPathRoot(node: Node, receiver: string): boolean {
    const inline = /^(?:[\w.]*\.)?Q[A-Z]\w*\.\w+(?:\.|$)/.test(receiver);
    const root = /^([a-z_$][\w$]*)\./.exec(receiver)?.[1];
    if (inline) return true;
    if (!root) return false;
    const declared = localDeclaredType(node, root) ?? this.fieldTypes.get(root) ?? null;
    return (declared ? /^Q[A-Z]/.test(declared) : false) || this.querydslPaths!.has(root);
  }

  /**
   * The request a Spring `WebClient` / `RestClient` chain sends: the verb it
   * picks (`get()`, `method(HttpMethod.POST)`), the `uri(…)` it names and the
   * base of the client it starts from — built inline, or held by a variable,
   * field or property whose initializer builds it. A client whose base this
   * file does not state reads as an unknown base named for it (`${web}/clubs`).
   * Null when the chain names no uri.
   */
  private springFluentRequest(node: Node): { verb: string; target: string | null } | null {
    const { calls, root } = fluentChain(receiverNode(node));
    const uri = calls.find((c) => c.name === "uri");
    if (!uri) return null;
    const verb = calls.find((c) => FLUENT_VERBS.has(c.name) && c.args.length === 0)?.name.toUpperCase() ??
      /\bHttpMethod\.(\w+)/.exec(calls.find((c) => c.name === "method")?.args[0]?.text ?? "")?.[1];
    if (!verb) return null;
    const path = fluentUriPath(uri.args[0], node);
    if (path === null) return { verb, target: null };
    if (/^https?:\/\//i.test(path)) return { verb, target: path };
    let base = springClientBase(calls);
    let variable: string | null = null;
    if (base === undefined && root) {
      variable = /^(?:this\.)?(\w+)$/.exec(root.text.trim())?.[1] ?? null;
      const init = variable ? (localInitializer(node, variable) ?? memberInitializer(node, variable)) : null;
      if (init) {
        const own = resolveCall(init);
        const chain = fluentChain(receiverNode(init));
        base = springClientBase(own ? [{ name: own.method, args: callArguments(init), receiver: own.receiver }, ...chain.calls] : chain.calls);
      }
    }
    const baseText = base ? (urlExpression(base, node, 0) ?? "${" + base.text.replace(/\s+/g, " ").replace(/^this\./, "") + "}") : base === null ? "" : variable ? "${" + variable + "}" : "";
    const joined = baseText ? `${baseText.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}` : path;
    return { verb, target: REQUEST_URL_RE.test(joined) ? joined : null };
  }

  /**
   * The request a CXF `WebClient` send makes: the base the client was created with (`WebClient.create(base)`,
   * a factory's first argument), else an unknown base named for the client, then every `path(…)` set on it —
   * chained into the send, chained into its initializer, or called on the variable earlier in the method.
   * `replacePath(…)` starts over. Null when the receiver is no `WebClient`.
   */
  private cxfWebClientRequest(node: Node, call: CallParts): { verb: string; target: string } | null {
    const segments: Node[] = [];
    let base: Node | null = null;
    let variable: string | null = null;
    // Walks a chain down to its root, keeping the path segments in order: `WebClient.create(base).path("x")`.
    const walk = (start: Node | null): boolean => {
      for (let cur = start; cur; cur = cur.childForFieldName("object")) {
        if (cur.type === "identifier" || cur.type === "field_access") { variable ??= cur.text.replace(/^this\./, ""); return true; }
        if (cur.type !== "method_invocation") return false;
        const name = cur.childForFieldName("name")?.text ?? "";
        const arg = firstJavaArg(cur.childForFieldName("arguments"));
        if ((name === "path" || name === "replacePath") && arg) segments.unshift(arg);
        if (name === "replacePath") return false;
        if (CXF_CLIENT_FACTORIES.has(name) && arg) { base = arg; return false; }
      }
      return false;
    };
    const toVariable = walk(node.childForFieldName("object"));
    if (toVariable && variable) {
      const name: string = variable;
      if ((localDeclaredType(node, name) ?? this.fieldTypes.get(name) ?? null) !== "WebClient") return null;
      // Earlier statements on the variable, latest first, back to a `replacePath`.
      let reset = false;
      for (const c of cxfCallsOn(node, name).reverse()) {
        const cname = c.childForFieldName("name")?.text;
        const arg = firstJavaArg(c.childForFieldName("arguments"));
        if ((cname === "path" || cname === "replacePath") && arg) segments.unshift(arg);
        if (cname === "replacePath") { reset = true; break; }
      }
      // The initializer gives the base; after a `replacePath` its paths no longer apply.
      const init = localInitializer(node, name);
      const set = segments.length;
      if (init) walk(init);
      if (reset) segments.splice(0, segments.length - set);
    } else if (!base) return null;
    const verb = CXF_VERB[call.method] ?? /^"(\w+)"$/.exec(call.firstArg?.text ?? "")?.[1]?.toUpperCase();
    if (!verb) return null;
    const render = (n: Node): string => urlExpression(n, node, 0) ?? "${" + n.text.replace(/\s+/g, " ") + "}";
    const baseNode = base as Node | null;
    const baseText = baseNode ? render(baseNode) : "${" + (variable ?? "client") + "}";
    const path = segments.map((s) => render(s).replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
    return { verb, target: path ? `${baseText.replace(/\/+$/, "")}/${path}` : baseText };
  }

  /** A JDBC/JPA handle by its last segment, unless it is named or declared as a service-layer object. */
  /** A RabbitMQ `Channel`: declared as one, or named so. */
  /** A messaging template: declared as one (`private JmsTemplate jms`), else named like one (`rabbitTemplate`). */
  private isMqTemplate(node: Node, receiver: string): boolean {
    const leaf = receiverLeaf(receiver);
    const declared = /^\w+$/.test(leaf) ? (localDeclaredType(node, leaf) ?? this.fieldTypes.get(leaf) ?? null) : null;
    return (declared !== null && MQ_TEMPLATE_TYPE_RE.test(declared)) || MQ_TEMPLATE_RECEIVER_RE.test(receiver);
  }

  private isAmqpChannel(node: Node, receiver: string): boolean {
    const leaf = receiverLeaf(receiver);
    const declared = /^\w+$/.test(leaf) ? (localDeclaredType(node, leaf) ?? this.fieldTypes.get(leaf) ?? null) : null;
    return declared ? /^(?:\w+\.)*Channel$/.test(declared) : /channel$/i.test(leaf);
  }

  private isJdbcReceiver(node: Node, receiver: string): boolean {
    // `new JdbcTemplate(dataSource).queryForObject(…)`: a handle built in place.
    const built = /^new\s+([\w.]+)\s*[(<]/.exec(receiver.trim())?.[1]?.split(".").pop();
    if (built) return JDBC_RECEIVER_RE.test(built) && !NON_DB_SESSION_RE.test(built);
    const leaf = receiverLeaf(receiver);
    const declared = /^\w+$/.test(leaf) ? (localDeclaredType(node, leaf) ?? this.fieldTypes.get(leaf) ?? null) : null;
    // A handle declared as one (`private JdbcTemplate template`) is one whatever it is called.
    if (declared && JDBC_RECEIVER_RE.test(declared) && !NON_DB_SESSION_RE.test(declared)) return true;
    // A plain JDBC statement (`Statement statement = connection.createStatement()`), or a JCR
    // query manager (`queryManager.createQuery(xpath, Query.XPATH)`).
    if (declared && /^(?:(?:Prepared|Callable)?Statement|QueryManager)$/.test(declared)) return true;
    // A query chain on a handle (`em.createQuery(…).getResultList()`) is still that handle's.
    if (!JDBC_RECEIVER_RE.test(leaf) && !/^(?:this\.)?(?:em|entityManager|session)\s*\./i.test(receiver)) return false;
    if (SERVICE_LAYER_NAME_RE.test(leaf) || NON_DB_SESSION_RE.test(leaf)) return false;
    // `request.getSession()` is the servlet's; Hibernate's `getSession()` has no request in front of it.
    if (/\b\w*(?:request|req)\s*\.\s*getSession\s*\(/i.test(receiver)) return false;
    // `EntityManager` ends like a service-layer `…Manager` but is the handle itself.
    return !(declared && SERVICE_LAYER_TYPE_RE.test(declared) && !JDBC_RECEIVER_RE.test(declared));
  }

  /** The declared type of an instance argument: `person`, `this.order`, `opt.get()` on an `Optional<X>`. */
  private instanceArgType(node: Node, arg: Node | null): string | null {
    if (!arg) return null;
    // `em.persist(new MatchReport(…))`: the object built in place states its type.
    const built = constructedType(arg);
    if (built) return /^[A-Z]\w/.test(built) && !NOT_AN_ENTITY_LITERAL.has(built) ? built : null;
    // `em.persist(createStadium(original))`: a method of the same class, by its declared return type.
    if (arg.type === "method_invocation" && (!arg.childForFieldName("object") || arg.childForFieldName("object")?.type === "this")) {
      const own = ownMethodReturnType(arg, arg.childForFieldName("name")?.text ?? "");
      return own && /^[A-Z]\w/.test(own) && !NOT_AN_ENTITY_LITERAL.has(own) ? own : null;
    }
    const text = arg.text.replace(/^this\./, "");
    const opt = /^(\w+)\.(?:get|orElseThrow|orElse)\s*\(/.exec(text)?.[1];
    if (opt) {
      const raw = localDeclaredType(node, opt, true);
      const inner = raw ? /^(?:java\.util\.)?Optional\s*<\s*([\w.]+)\s*>$/.exec(raw)?.[1] : null;
      return inner ? simpleTypeName(inner) : null;
    }
    if (!/^\w+$/.test(text)) return null;
    const type = localDeclaredType(node, text) ?? this.fieldTypes.get(text) ?? null;
    return type && /^[A-Z]\w/.test(type) && !NOT_AN_ENTITY_LITERAL.has(type) ? type : null;
  }

  /**
   * Event type published by this call, scanning arguments right-to-left:
   * `new ClubCreatedEvent(…)` → ClubCreatedEvent;
   * `AccountUpdateMessage.newBuilder()…build()` → AccountUpdateMessage;
   * a bare identifier → its declared local/parameter/field type.
   * Non-`publishEvent` verbs require the EVENT_TYPE_RE suffix (`relaxed`
   * lifts that for constructor args of the unambiguous `publishEvent`). A
   * parameter declared loosely (`Object dwEvent`) takes the event types this
   * file's calls of its method hand it — one per type.
   */
  private resolveEventArgs(call: Node, relaxed: boolean): string[] {
    const args = callArguments(call);
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i]!;
      const text = arg.text;
      const ctorType = constructedType(arg);
      if (ctorType && (relaxed || EVENT_TYPE_RE.test(ctorType))) return [ctorType];

      // Identifier: resolve the declared type — enclosing-method local or
      // parameter first, then a class field. Always suffix-fenced: without a
      // constructor in sight the type is the only event-shaped evidence.
      if (/^[\w$]+$/.test(text)) {
        const t = localDeclaredType(call, text) ?? this.fieldTypes.get(text) ?? null;
        // A parameter of a generic payload type (`send(Metadata md, Message message)`) is whatever this file's
        // callers hand the method; the type itself only when they say nothing more.
        const handed = !t || !EVENT_TYPE_RE.test(t) || GENERIC_EVENT_TYPE_RE.test(t) ? parameterArgTypes(call, text) : [];
        if (handed.length > 0) return handed;
        if (t && EVENT_TYPE_RE.test(t)) return [t];
      }

      // A method of this file builds it: `publishEvent(computeChangedEvent(old, now))` → its declared return type.
      if (arg.type === "method_invocation" && !arg.childForFieldName("object")) {
        const name = arg.childForFieldName("name")?.text;
        const decls = call.tree.rootNode.descendantsOfType("method_declaration").filter((d) => d?.childForFieldName("name")?.text === name);
        const types = new Set(decls.map((d) => simpleTypeName(d!.childForFieldName("type")?.text)));
        const t = types.size === 1 ? [...types][0] : null;
        if (t && EVENT_TYPE_RE.test(t)) return [t];
      }
    }
    return [];
  }
}

/** A string a local of the enclosing method holds: `String sql = """ SELECT … """;` (its one assignment). */
function localStringValue(at: Node, name: string, consts: ReadonlyMap<string, string>): string | null {
  let method: Node | null = at.parent;
  while (method && !/^(?:method_declaration|constructor_declaration|lambda_expression)$/.test(method.type)) method = method.parent;
  if (!method) return null;
  const values: string[] = [];
  for (const decl of method.descendantsOfType("variable_declarator")) {
    if (decl?.childForFieldName("name")?.text !== name || decl.startIndex > at.startIndex) continue;
    const value = decl.childForFieldName("value");
    const text = value ? stringArgText(value, consts) : null;
    if (text) values.push(text);
  }
  return values.length === 1 ? values[0]! : null;
}

/** `TypedQuery<Player> q = em.createQuery(…)` / `Query<Player>` (Hibernate): the result type the declaration states. */
function typedQueryEntity(call: Node): string | null {
  let n: Node | null = call;
  while (n && n.type !== "variable_declarator" && n.type !== "expression_statement" && n.type !== "block") n = n.parent;
  const decl = n?.type === "variable_declarator" ? n.parent : null;
  const type = decl?.type === "local_variable_declaration" || decl?.type === "field_declaration" ? decl.childForFieldName("type")?.text : null;
  const m = type ? /^(?:TypedQuery|Query|NativeQuery|SelectionQuery)\s*<\s*([A-Z]\w*)\s*>$/.exec(type) : null;
  // `TypedQuery<T>` in a generic DAO names a type parameter, no entity.
  return m && !NOT_AN_ENTITY_LITERAL.has(m[1]!) && !/^(?:Long|Integer|String|Object|Tuple|Boolean|Double|[A-Z]\d?)$/.test(m[1]!) ? m[1]! : null;
}

/** The one declared return type of the enclosing class's methods named `name`, generics dropped; null for none or several. */
function ownMethodReturnType(from: Node, name: string): string | null {
  if (!name) return null;
  let body: Node | null = from.parent;
  while (body && body.type !== "class_body" && body.type !== "enum_body") body = body.parent;
  if (!body) return null;
  const types = new Set<string>();
  for (const m of body.namedChildren) {
    if (m.type !== "method_declaration" || m.childForFieldName("name")?.text !== name) continue;
    const t = simpleTypeName(m.childForFieldName("type")?.text?.replace(/<[\s\S]*$/, ""));
    if (t) types.add(t);
  }
  return types.size === 1 ? [...types][0]! : null;
}

/** The parameter names of the method or constructor enclosing `node`. */
function enclosingParamNames(node: Node): Set<string> {
  let m: Node | null = node.parent;
  while (m && m.type !== "method_declaration" && m.type !== "constructor_declaration") m = m.parent;
  const params = m?.childForFieldName("parameters")?.namedChildren ?? [];
  return new Set(params.map((p) => p?.childForFieldName("name")?.text).filter((n): n is string => !!n));
}

/** The type an argument builds: Java `new X(...)`, Kotlin `X(...)`, a builder chain rooted at it (`X.newBuilder()…`). */
function constructedType(arg: Node): string | null {
  const text = arg.text;
  return arg.type === "object_creation_expression"
    ? simpleTypeName(arg.childForFieldName("type")?.text)
    : arg.type === "call_expression" && /^[A-Z]\w*\s*\(/.test(text)
      ? simpleTypeName(text.slice(0, text.indexOf("(")))
      : text.match(/^([A-Z]\w*)\s*\.\s*newBuilder\b/)?.[1] ?? null;
}

/**
 * The event types the file's own calls of the enclosing method pass for its
 * parameter `name` (`sendDWEvent(entity, audit, MatchPlayedEvent.newBuilder()…build())`
 * into `void sendDWEvent(…, Object event)`), event-shaped ones only.
 */
/**
 * The position, among the enclosing method's parameters, of the rightmost call
 * argument that is one of them and is not typed as an event (`Object event`) —
 * the payload a helper publishes for whoever calls it. Null otherwise.
 */
function payloadParameter(call: Node): number | null {
  let method: Node | null = call.parent;
  while (method && method.type !== "method_declaration") method = method.parent;
  const params = method?.childForFieldName("parameters")?.namedChildren.filter((p) => p.type === "formal_parameter") ?? [];
  const args = callArguments(call);
  for (let i = args.length - 1; i >= 0; i--) {
    const index = params.findIndex((p) => p.childForFieldName("name")?.text === args[i]!.text);
    if (index < 0) continue;
    const type = simpleTypeName(params[index]!.childForFieldName("type")?.text);
    return type && EVENT_TYPE_RE.test(type) && !GENERIC_EVENT_TYPE_RE.test(type) ? null : index;
  }
  return null;
}

function parameterArgTypes(at: Node, name: string): string[] {
  let method: Node | null = at.parent;
  while (method && method.type !== "method_declaration") method = method.parent;
  const params = method?.childForFieldName("parameters")?.namedChildren.filter((p) => p.type === "formal_parameter") ?? [];
  const index = params.findIndex((p) => p.childForFieldName("name")?.text === name);
  const methodName = method?.childForFieldName("name")?.text;
  if (index < 0 || !methodName) return [];
  const out = new Set<string>();
  for (const inv of at.tree.rootNode.descendantsOfType("method_invocation")) {
    if (!inv || inv.childForFieldName("name")?.text !== methodName) continue;
    const object = inv.childForFieldName("object");
    if (object && object.type !== "this") continue;
    const arg = callArguments(inv)[index];
    if (!arg) continue;
    const t = constructedType(arg) ?? (/^[\w$]+$/.test(arg.text) ? localDeclaredType(inv, arg.text) : null);
    if (t && EVENT_TYPE_RE.test(t)) out.add(t);
  }
  return [...out];
}

/**
 * Broker-destination label from a template call's first argument: a string
 * literal's unquoted value, or any other expression's source text
 * (`RabbitConfig.ORDERS_EXCHANGE`) — still a usable join key.
 */
/** A destination named by a constant (`Topics.CLUB_EVENTS`, `CLUB_EVENTS`): the name, for the project pass to read. */
function constantRef(arg: Node | null): string | null {
  const t = constantString(arg);
  const m = t ? /^\$\{([^{}]+)\}$/.exec(t) : null;
  return m ? m[1]! : null;
}

function destinationLabel(arg: Node | null): string | null {
  if (!arg) return null;
  const text = /string/.test(arg.type)
    ? arg.text.replace(/^"|"$/g, "")
    : arg.text.replace(/\s+/g, " ");
  return text && text.length <= 64 ? text : null;
}

export interface CallParts {
  /** Bare method name (`selectFrom`, `findByEmail`). */
  method: string;
  /** Receiver text (`jdbcTemplate`, `JooqFactory.getDSL()`), "" when unqualified. */
  receiver: string;
  /** First argument expression node, unwrapped (Kotlin `value_argument` peeled). */
  firstArg: Node | null;
}

/**
 * Resolve method name / receiver / first-arg for both Java `method_invocation`
 * (field-based) and Kotlin `call_expression` (navigation_expression + call_suffix).
 */
/** The entity a JPA call names: a `X.class` argument, else `from X` inside a string argument. */
function jpaEntityArg(node: Node): string | null {
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "call_suffix" || c.type === "value_arguments");
  return jpaEntityText(args?.text ?? "");
}

/** Class literals that are a matcher's or a scalar result's, never an entity (`Unit` stays: Kotlin's is not Java's). */
const NOT_AN_ENTITY_LITERAL = new Set([
  "Class", "Object", "String", "Integer", "Long", "Short", "Byte", "Boolean", "Double", "Float", "Character",
  "Number", "BigDecimal", "BigInteger", "Date", "LocalDate", "LocalDateTime", "Instant", "UUID", "Void",
  "Map", "List", "Set", "Collection", "Tuple",
]);

const JPQL_KEYWORDS = new Set(["WHERE", "JOIN", "LEFT", "INNER", "OUTER", "ORDER", "GROUP", "HAVING", "SET", "VALUES", "SELECT", "UNION", "LIMIT", "AND", "OR", "ON"]);

function jpaEntityText(text: string): string | null {
  // The first class literal naming a type of the program: `any(Class.class)` (a mock matcher) and
  // `String.class` (a scalar result) name none.
  for (const m of text.matchAll(/\b([A-Z]\w*)(?:\.class|::class(?:\.java)?)\b/g)) {
    if (!NOT_AN_ENTITY_LITERAL.has(m[1]!)) return m[1]!;
  }
  const jpql = /["']\s*(?:select\b[^"']*?)?\bfrom\s+([A-Z]\w*)\b/i.exec(text);
  // `"… FROM " + table + " WHERE …"` joined: the keyword after the hole names nothing
  // (an entity is spelled as its class, `FROM Order o`, never in capitals).
  return jpql && /^[A-Z]/.test(jpql[1]!) && !JPQL_KEYWORDS.has(jpql[1]!) ? jpql[1]! : null;
}

export function resolveCall(node: Node): CallParts | null {
  if (node.type === "method_invocation") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const obj = node.childForFieldName("object");
    const argList = node.childForFieldName("arguments");
    return { method: name, receiver: obj?.text ?? "", firstArg: firstJavaArg(argList) };
  }

  // Kotlin call_expression: child(0) is the callee, followed by a call_suffix.
  const callee = node.child(0);
  if (!callee) return null;
  let method: string | null = null;
  let receiver = "";
  if (callee.type === "navigation_expression") {
    const suffix = callee.children.find((c) => c.type === "navigation_suffix");
    method = suffix?.children.find((c) => c.type === "simple_identifier")?.text ?? null;
    receiver = callee.child(0)?.text ?? "";
  } else if (callee.type === "simple_identifier") {
    method = callee.text; // unqualified call, e.g. `table("x")`
  }
  if (!method) return null;
  const callSuffix = node.children.find((c) => c.type === "call_suffix");
  const valueArgs = callSuffix?.children.find((c) => c.type === "value_arguments");
  return { method, receiver, firstArg: firstKotlinArg(valueArgs) };
}

/** First real argument of a Java `argument_list` (skips `(` `,` `)`). */
function firstJavaArg(argList: Node | null | undefined): Node | null {
  if (!argList) return null;
  for (const c of argList.children) {
    if (c.isNamed && c.type !== "comment") return c;
  }
  return null;
}

/** First argument expression of a Kotlin `value_arguments` (peels `value_argument`). */
function firstKotlinArg(valueArgs: Node | null | undefined): Node | null {
  if (!valueArgs) return null;
  const arg = valueArgs.children.find((c) => c.type === "value_argument");
  if (!arg) return null;
  // value_argument wraps the expression (and optionally a `name =` prefix); the
  // expression is its last named child.
  const named = arg.children.filter((c) => c.isNamed);
  return named[named.length - 1] ?? null;
}

/**
 * Resolve a jOOQ table name from a query-builder argument:
 *   - `table("sps.Module")` / `tableByName(...)` → "Module" (schema stripped)
 *   - `STUDENT` / `Tables.MODULESETTING` (ALL-CAPS generated constant) → last segment
 *   - `GRANTITEM.as("gi")` (aliased table) → resolve the receiver → "GRANTITEM"
 *   - `TABLE` / `em` where a file-local `val TABLE = DSL.table("X")` binding
 *     exists → the bound table ("X")
 * Returns null for anything that doesn't look like a table (lowercase locals,
 * `this.table`, PascalCase types) so generic verbs (`from`, `update`, `join`)
 * stay safe.
 */
function resolveTableExpr(arg: Node | null, aliases: Map<string, string>): string | null {
  if (!arg) return null;

  if (arg.type === "method_invocation" || arg.type === "call_expression") {
    const inner = resolveCall(arg);
    if (!inner) return null;
    // `table("name")` / `tableByName("name")` literal form.
    if (JOOQ_TABLE_FNS.has(inner.method)) {
      const lit = stringLiteralValue(inner.firstArg);
      return lit ? lit.split(".").pop()! : null; // drop schema prefix (`sps.Module` → `Module`)
    }
    // `<table>.as("alias")` — resolve the receiver.
    if (inner.method === "as") {
      return resolveTableExpr(receiverNode(arg), aliases);
    }
    return null;
  }

  // Bare/qualified reference: alias binding first, then ALL-CAPS constant.
  const seg = arg.text.split(/[.]/).pop()?.trim() ?? "";
  if (aliases.has(seg)) return aliases.get(seg)!;
  return TABLE_CONST_RE.test(seg) && seg.length > 1 ? seg : null;
}

/**
 * Entity behind a DAO/Repository receiver. The receiver's DECLARED TYPE wins
 * when the file declares it and the type itself is DAO-shaped — a field named
 * `licenceIdJpaRepository` of type `ClubLicenceJpaRepository` accesses
 * ClubLicence, which only the type knows. Otherwise the receiver name is
 * used (`this.caseDAO` → "case"). In both, the `DAO`/`Repository` suffix is
 * stripped, plus a residual persistence-tech suffix (`ClubJpaRepository` →
 * `AccountJpa` → `Account`) and an interface-convention `I` prefix
 * (`ICaseDAO` → `Case`). The prefix convention works the same way
 * (`RepositoryClass` → `Class`). Null when the receiver isn't a DAO.
 */
/** `select … from Match m` (JPQL names an entity, Capitalized) among a constructor's string arguments. */
function constructorJpqlEntity(node: Node): string | null {
  const args = node.childForFieldName("arguments");
  if (!args || !/select/i.test(args.text)) return null;
  for (const arg of args.namedChildren) {
    if (!arg) continue;
    const text = stringArgText(arg);
    const m = text ? /^\s*(?:select|SELECT|Select)\b[\s\S]*?\b(?:from|FROM|From)\s+([A-Z]\w*)\b/.exec(text) : null;
    if (m && !NOT_AN_ENTITY_LITERAL.has(m[1]!)) return m[1]!;
  }
  return null;
}

/**
 * The literal text of a string argument, a concatenation of literals included;
 * inside a concatenation, a name the file holds a string constant under
 * (`"INSERT INTO " + TABLE + " (…)"`) reads as its value.
 */
function stringArgText(arg: Node, consts?: ReadonlyMap<string, string>): string | null {
  if (arg.type === "string_literal" || arg.type === "text_block") return arg.text.replace(/^"(?:"")?|(?:"")?"$/g, "");
  if (arg.type === "parenthesized_expression") return concatText(arg.namedChildren, consts);
  if (arg.type === "binary_expression") return concatText(arg.namedChildren, consts);
  return null;
}

/** The parts' literal text joined, a non-literal part as a space; null when none is literal. */
function concatText(parts: ReadonlyArray<Node | null>, consts?: ReadonlyMap<string, string>): string | null {
  const texts = parts.map((part) => (part ? stringArgText(part, consts) ?? constantText(part, consts) : null));
  if (texts.every((t) => t === null)) return null;
  return texts.map((t) => t ?? " ").join("");
}

/** `TABLE`, `this.TABLE`, `Owner.TABLE` — the file's string constant of that name. */
function constantText(part: Node, consts?: ReadonlyMap<string, string>): string | null {
  if (!consts) return null;
  if (part.type === "identifier") return consts.get(part.text) ?? null;
  if (part.type !== "field_access") return null;
  // `this.TABLE` / `Owner.TABLE` — never `spec.table`, another object's field.
  const owner = part.childForFieldName("object");
  if (!owner || !(owner.type === "this" || /^[A-Z]/.test(owner.text))) return null;
  return consts.get(part.childForFieldName("field")?.text ?? "") ?? null;
}

/** The texts a string expression can hold: both arms of a `cond ? a : b`. */
function stringArmTexts(value: Node, consts?: ReadonlyMap<string, string>): string[] {
  if (value.type === "ternary_expression") {
    return [value.childForFieldName("consequence"), value.childForFieldName("alternative")]
      .flatMap((arm) => (arm ? stringArmTexts(arm, consts) : []));
  }
  if (value.type === "parenthesized_expression" && value.namedChildren.length === 1) return stringArmTexts(value.namedChildren[0]!, consts);
  const text = stringArgText(value, consts);
  return text ? [text] : [];
}

/** The entity (JPQL) or table (SQL) a query constant reads or writes. */
function constantQueryTarget(text: string): { entity: string; access?: "read" | "write" } | null {
  const sql = tableFrom(text);
  const entity = jpaEntityText(`"${text}"`) ?? sql?.table.split(".").pop();
  if (!entity) return null;
  if (!sql) return { entity };
  return { entity, ...withAccess(sqlVerbAccess(sql.verb)) };
}

/** What a DAO's name says when it is no entity's: it serves every entity. */
const GENERIC_DAO_NAME = /^(?:common|generic|base|abstract|default|crud|shared|core|main|global|entity|data|persistence|hibernate|jpa|db|database|app|simple)$/i;

export function daoReceiverEntity(receiver: string, fieldTypes?: Map<string, string>): string | null {
  const seg = receiver.split(".").pop()?.trim() ?? "";
  const declared = fieldTypes?.get(seg);
  const src = declared && daoBase(declared) ? declared : seg;
  let base = daoBase(src);
  if (!base) return null;
  base = base.replace(/(jpa|db)$/i, "").replace(/^I(?=[A-Z])/, "");
  return base.length > 1 ? base : null;
}


/** Entity-bearing part of a DAO-shaped name — suffix form first, then prefix form. */
function daoBase(name: string): string | undefined {
  const suffix = DAO_RECEIVER_RE.exec(name)?.[1];
  if (suffix) return suffix;
  const prefix = DAO_PREFIX_RE.exec(name)?.[1];
  return prefix && !DAO_PREFIX_ROLE_VETO.test(prefix) ? prefix : undefined;
}

/** Argument expression nodes of a Java/Kotlin call, in order. */
export function callArguments(call: Node): Node[] {
  if (call.type === "method_invocation") {
    const argList = call.childForFieldName("arguments");
    return argList ? argList.children.filter((c) => c.isNamed && c.type !== "comment") : [];
  }
  const callSuffix = call.children.find((c) => c.type === "call_suffix");
  const valueArgs = callSuffix?.children.find((c) => c.type === "value_arguments");
  if (!valueArgs) return [];
  const out: Node[] = [];
  for (const va of valueArgs.children) {
    if (va.type !== "value_argument") continue;
    const named = va.children.filter((c) => c.isNamed);
    const expr = named[named.length - 1];
    if (expr) out.push(expr);
  }
  return out;
}

/**
 * Declared type of `name` in the function enclosing `node`: a Java
 * `local_variable_declaration` / Kotlin typed local `property_declaration`,
 * or a parameter of the enclosing method. Returns a simple type name.
 */
/**
 * The class an untyped lambda parameter holds when the chain the lambda is handed to starts from a
 * call naming it: `client.fetch(Club.class, id).ifPresent(club -> …)`,
 * `client.list(Club.class, opts).flatMap(club -> client.update(club))`.
 */
function lambdaParamClass(node: Node, name: string): string | null {
  for (let at: Node | null = node.parent; at; at = at.parent) {
    if (at.type !== "lambda_expression") continue;
    const params = at.childForFieldName("parameters");
    const names = params ? (params.type === "identifier" ? [params.text] : params.descendantsOfType("identifier").map((n) => n?.text)) : [];
    if (!names.includes(name)) continue;
    const call = at.parent?.type === "argument_list" ? at.parent.parent : null;
    for (let link: Node | null | undefined = call?.type === "method_invocation" ? call.childForFieldName("object") : null; link?.type === "method_invocation"; link = link.childForFieldName("object")) {
      const args = link.childForFieldName("arguments");
      const first = args?.namedChildren[0];
      const m = first ? /^([A-Z]\w*)\.class$/.exec(first.text) : null;
      if (m) return m[1]!;
      // `.flatMap(name -> client.get(User.class, name))`: the link's own lambda fetches the entity.
      const fetched = first?.type === "lambda_expression" ? /\b(?:get|fetch|list|listAll|listBy)\s*\(\s*([A-Z]\w*)\.class\b/.exec(first.text) : null;
      if (fetched) return fetched[1]!;
    }
    return call?.type === "method_invocation" ? streamElementType(call, at) : null;
  }
  return null;
}

/** Stream/reactive steps handing their element to a lambda's (first) parameter. */
const ELEMENT_STEPS = /^(?:flatMap|map|concatMap|flatMapMany|filter|filterWhen|doOnNext|doOnSuccess|forEach|forEachOrdered|ifPresent|ifPresentOrElse|subscribe|anyMatch|allMatch|noneMatch|peek|then)$/;
/** Steps that keep the element type: what they hand on is what they were handed. */
const KEEPING_STEPS = /^(?:filter|filterWhen|doOnNext|doOnSuccess|doOnError|doFinally|switchIfEmpty|defaultIfEmpty|onErrorResume|onErrorMap|retry|retryWhen|timeout|cache|log|sort|sorted|distinct|take|skip|limit|peek|subscribeOn|publishOn|stream)$/;
/** One-element and many-element containers whose element a step hands to its lambda. */
const CONTAINER_RE = /^(?:Mono|Flux|Optional|List|Set|Collection|Iterable|Stream|Uni|Multi)<\s*([A-Z][\w.]*)\s*>$/;

/**
 * The element a stream step hands its lambda (`userMono.flatMap(user -> …)` with `Mono<User> userMono`,
 * `getUser(name).filter(…).flatMap(user -> …)` with `Mono<User> getUser(…)` in the file): the
 * chain's root is a variable or a same-file method whose declared type is a container of
 * that element, and every step in between keeps it.
 */
function streamElementType(call: Node, lambda: Node): string | null {
  if (!ELEMENT_STEPS.test(call.childForFieldName("name")?.text ?? "")) return null;
  // The lambda the step hands its element to is its first argument.
  if (call.childForFieldName("arguments")?.namedChildren[0]?.id !== lambda.id) return null;
  let root: Node | null | undefined = call.childForFieldName("object");
  while (root?.type === "method_invocation" && root.childForFieldName("object") && KEEPING_STEPS.test(root.childForFieldName("name")?.text ?? "")) {
    root = root.childForFieldName("object");
  }
  let declared: string | null = null;
  if (root?.type === "identifier") declared = declaredOutward(root, root.text);
  else if (root?.type === "method_invocation" && !root.childForFieldName("object")) declared = sameFileReturnType(root, root.childForFieldName("name")?.text);
  const inner = declared ? CONTAINER_RE.exec(declared.replace(/\s+/g, ""))?.[1] : undefined;
  return inner ? simpleTypeName(inner) : null;
}

/** A name's declared type as written, in the enclosing function or, from inside a lambda, the functions around it. */
function declaredOutward(node: Node, name: string): string | null {
  for (let at: Node | null = node; at; ) {
    const declared = localDeclaredType(at, name, true);
    if (declared) return declared;
    let fn: Node | null = at.parent;
    while (fn && !/^(method_declaration|constructor_declaration|function_declaration|lambda_expression|lambda_literal)$/.test(fn.type)) fn = fn.parent;
    if (!fn || fn.type !== "lambda_expression") return null;
    at = fn;
  }
  return null;
}

/** A method of this file's declared return type, as written (`Mono<User>`). */
function sameFileReturnType(node: Node, callee: string | undefined): string | null {
  if (!callee) return null;
  const method = node.tree.rootNode.descendantsOfType("method_declaration").find((m) => m?.childForFieldName("name")?.text === callee);
  return method?.childForFieldName("type")?.text ?? null;
}

/**
 * The entity a call handed to an extension client produces: a same-file method's declared
 * return (`client.create(createAdmin(…))`), or a function variable's result
 * (`func.apply(post)` with `UnaryOperator<Post> func`).
 */
function producedEntityType(node: Node, arg: Node): string | null {
  if (arg.type !== "method_invocation") return null;
  const object = arg.childForFieldName("object");
  const name = arg.childForFieldName("name")?.text;
  let declared: string | null = null;
  if (!object) declared = sameFileReturnType(node, name);
  else if (object.type === "identifier" && /^(?:apply|get)$/.test(name ?? "")) {
    const fnType = (declaredOutward(node, object.text) ?? "").replace(/\s+/g, "");
    declared = /^(?:UnaryOperator|Supplier)<([A-Z][\w.]*)>$/.exec(fnType)?.[1] ?? /^(?:Bi)?Function<.*,([A-Z][\w.]*)>$/.exec(fnType)?.[1] ?? null;
  }
  if (!declared) return null;
  const inner = /^(?:Mono|Optional|Uni|CompletableFuture)<\s*([A-Z][\w.]*)\s*>$/.exec(declared.replace(/\s+/g, ""))?.[1] ?? declared;
  return /^[A-Z][\w.]*$/.test(inner) ? simpleTypeName(inner) : null;
}

/**
 * The entity class an object handed to an extension client holds: its declared
 * type in the enclosing function — or, inside a lambda, in the method around it
 * (`post` a parameter of `update(Post post)` read in `.flatMap(w -> client.update(post))`);
 * a `var` built by `new X(…)` or by a method of the file declaring its return type
 * (`var reason = createReason(…)` → `Reason`); else the class the lambda chain it
 * arrives through fetches.
 */
function heldEntityType(node: Node, name: string): string | null {
  for (let at: Node | null = node; at; ) {
    const declared = localDeclaredType(at, name);
    if (declared && declared !== "var" && declared !== "val") return declared;
    if (declared === "var" || declared === "val") return initializerType(at, name);
    // Up to the next enclosing function (a lambda's enclosing method).
    let fn: Node | null = at.parent;
    while (fn && !/^(method_declaration|constructor_declaration|function_declaration|lambda_expression|lambda_literal)$/.test(fn.type)) fn = fn.parent;
    if (!fn || fn.type !== "lambda_expression") break;
    at = fn;
  }
  return lambdaParamClass(node, name);
}

/** The type a `var` is initialized to: `new X(…)`, an object-mapper conversion to `X.class`, or a same-file method's declared return type (`Mono<X>` → `X`). */
function initializerType(node: Node, name: string): string | null {
  let fn: Node | null = node.parent;
  while (fn && !/^(method_declaration|constructor_declaration|lambda_expression)$/.test(fn.type)) fn = fn.parent;
  for (const decl of fn?.descendantsOfType("variable_declarator") ?? []) {
    if (decl?.childForFieldName("name")?.text !== name) continue;
    const value = decl.childForFieldName("value");
    if (value?.type === "object_creation_expression") return simpleTypeName(value.childForFieldName("type")?.text);
    const converted = value ? convertedClass(value) : null;
    if (converted) return converted;
    // A fetch by class literal, unwrapped: `client.get(Club.class, name).block()`.
    const head = value ? chainHead(value) : null;
    const fetched = head?.type === "method_invocation" && /^(?:get|fetch)$/.test(head.childForFieldName("name")?.text ?? "")
      ? /^([A-Z]\w*)\.class$/.exec(head.childForFieldName("arguments")?.namedChildren[0]?.text ?? "")?.[1] : undefined;
    if (fetched && head!.id !== value!.id) return fetched;
    if (value?.type === "method_invocation" && !value.childForFieldName("object")) {
      const callee = value.childForFieldName("name")?.text;
      const method = node.tree.rootNode.descendantsOfType("method_declaration").find((m) => m?.childForFieldName("name")?.text === callee);
      const ret = method?.childForFieldName("type")?.text ?? "";
      const inner = /^(?:Mono|Optional|Flux|Uni|CompletableFuture)<\s*([A-Z][\w.]*)\s*>$/.exec(ret)?.[1] ?? ret;
      return /^[A-Z][\w.]*$/.test(inner) ? simpleTypeName(inner) : null;
    }
    return null;
  }
  return null;
}

/**
 * The class a typed object-mapper conversion produces: `mapper.convertValue(u, Setting.class)`,
 * `readValue(json, Setting.class)`, `treeToValue(node, Setting.class)` — also as the `.map(u -> …)`
 * step of a chain, past the steps that unwrap it (`….findFirst().map(u -> convertValue(u, X.class)).orElseThrow()`).
 */
function convertedClass(value: Node): string | null {
  let at: Node = value;
  while (at.type === "method_invocation" && UNWRAPPING_STEPS.test(at.childForFieldName("name")?.text ?? "") && at.childForFieldName("object")?.type === "method_invocation") {
    at = at.childForFieldName("object")!;
  }
  if (at.type === "method_invocation" && at.childForFieldName("name")?.text === "map") {
    const body = at.childForFieldName("arguments")?.namedChildren[0]?.childForFieldName("body");
    if (body?.type !== "method_invocation") return null;
    at = body;
  }
  if (at.type !== "method_invocation" || !/^(?:convertValue|readValue|treeToValue)$/.test(at.childForFieldName("name")?.text ?? "")) return null;
  const args = at.childForFieldName("arguments")?.namedChildren ?? [];
  return /^([A-Z]\w*)\.class$/.exec(args[args.length - 1]?.text ?? "")?.[1] ?? null;
}

function localDeclaredType(node: Node, name: string, raw = false): string | null {
  const simple = (t: string | null | undefined): string | null => (raw ? (t?.trim() || null) : simpleTypeName(t));
  let fn: Node | null = node.parent;
  while (fn && !/^(method_declaration|constructor_declaration|function_declaration|lambda_expression|lambda_literal)$/.test(fn.type)) {
    fn = fn.parent;
  }
  if (!fn) return null;

  const scan = (n: Node): string | null => {
    if (n.type === "local_variable_declaration") {
      for (const c of n.children) {
        if (c.type === "variable_declarator" && c.childForFieldName("name")?.text === name) {
          return simple(n.childForFieldName("type")?.text);
        }
      }
    } else if (n.type === "resource") {
      // `try (Statement statement = connection.createStatement())`
      if (n.childForFieldName("name")?.text === name) return simple(n.childForFieldName("type")?.text);
    } else if (n.type === "enhanced_for_statement") {
      // `for (SeasonTicketCategory c : categories)`
      if (n.childForFieldName("name")?.text === name) return simple(n.childForFieldName("type")?.text);
    } else if (n.type === "property_declaration") {
      const kt = kotlinNameAndType(n);
      if (kt.name === name) return simple(kt.type);
    } else if (n.type === "formal_parameter" || n.type === "parameter") {
      const kt = kotlinNameAndType(n);
      const pName = n.childForFieldName("name")?.text ?? kt.name;
      if (pName === name) {
        return simple(n.childForFieldName("type")?.text ?? kt.type);
      }
    }
    for (const child of n.children) {
      const hit = scan(child);
      if (hit) return hit;
    }
    return null;
  };
  return scan(fn);
}

/** Annotations whose string argument is the method's SQL (or, for Room's write verbs, none). */
const SQL_ANNOTATION_RE = /^@(?:[\w.]+\.)?(Query|NativeQuery|SqlQuery|SqlUpdate|Select|Insert|Update|Delete|Upsert)\b/;

/** Room's write annotations, which take the entity as the method's parameter instead of SQL. */
const ROOM_WRITE_ANNOTATIONS = new Set(["Insert", "Update", "Delete", "Upsert"]);

/** Java/Kotlin string literals and text blocks inside an annotation's text. */
const ANN_STRING_RE = /"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)"/g;

/**
 * The table an SQL-carrying annotation reads or writes, on the line of the
 * method it decorates (so the access belongs to that method, not to whatever
 * precedes it). Concatenated literals (`"SELECT … " + "FROM t"`) are joined.
 */
function annotatedSqlAccess(
  ann: Node,
  text: string,
  name: string,
  isRoomFile: boolean,
): { table: string; access?: "read" | "write"; line: number } | null {
  let holder: Node | null = ann.parent;
  if (holder && holder.type === "modifiers") holder = holder.parent;
  if (!holder || !/^(method_declaration|function_declaration)$/.test(holder.type)) return null;
  const nameNode = holder.childForFieldName("name") ?? holder.children.find((c) => c.type === "simple_identifier") ?? null;
  const line = (nameNode ?? holder).startPosition.row + 1;

  const sql = [...text.matchAll(ANN_STRING_RE)].map((m) => m[1] ?? m[2] ?? "").join(" ").trim();
  if (sql) {
    const found = tableFrom(sql);
    if (!found) return null;
    const access = sqlVerbAccess(found.verb);
    return { table: found.table.split(".").pop()!, ...(access ? { access } : {}), line };
  }
  if (isRoomFile && ROOM_WRITE_ANNOTATIONS.has(name)) {
    const params = holder.childForFieldName("parameters") ?? holder.children.find((c) => c.type === "function_value_parameters");
    const first = params?.children.find((c) => c.type === "formal_parameter" || c.type === "parameter");
    const raw = first ? (first.childForFieldName("type")?.text ?? kotlinNameAndType(first).type) : null;
    // `insertAll(users: List<User>)`, `vararg users: User`: the element type is the entity.
    const element = simpleTypeName(raw?.replace(/^\s*(?:List|Set|Collection|Array|Iterable|MutableList)\s*<\s*(.+?)\s*>\s*$/, "$1"));
    return element ? { table: element, access: "write", line } : null;
  }
  return null;
}

/**
 * Subscribed event type of the method a listener annotation decorates —
 * `@MessageHandler void handle(ClubUpdatedEvent event, Metadata md)` →
 * ClubUpdatedEvent. Prefers the parameter whose type is event-shaped
 * (frameworks pass audit/metadata alongside the payload — e.g.
 * `handle(MatchLog a, Metadata m, KickoffMessage msg)`), falling back to
 * the first parameter. Climbs annotation → modifiers → declaration; null when
 * the annotation sits on a class or the method has no typed parameters.
 */
function handlerFirstParamType(ann: Node): string | null {
  let holder: Node | null = ann.parent;
  if (holder && holder.type === "modifiers") holder = holder.parent;
  if (!holder || !/^(method_declaration|function_declaration)$/.test(holder.type)) return null;

  // Java formal_parameters via field; Kotlin function_value_parameters child.
  const params = holder.childForFieldName("parameters")
    ?? holder.children.find((c) => c.type === "function_value_parameters");
  if (!params) return null;
  const types: string[] = [];
  for (const p of params.children) {
    if (p.type === "formal_parameter" || p.type === "parameter") {
      const t = simpleTypeName(p.childForFieldName("type")?.text ?? kotlinNameAndType(p).type);
      if (t) types.push(t);
    }
  }
  // The payload, after the audit / metadata parameters a typed framework puts first
  // (`handle(MatchLog audit, ReleaseResponse response)`); else the first parameter.
  return [...types].reverse().find((t) => EVENT_TYPE_RE.test(t)) ?? types[0] ?? null;
}

/** Receiver node of a `recv.method(...)` call (Java `object` field / Kotlin navigation). */
function receiverNode(call: Node): Node | null {
  if (call.type === "method_invocation") return call.childForFieldName("object");
  const callee = call.child(0);
  return callee?.type === "navigation_expression" ? callee.child(0) : null;
}

/**
 * ONE pre-pass walk per file, collecting two per-file indexes (fused — a
 * second full traversal is a real per-file cost on Java-heavy corpora):
 *  - tableAliases: file-local `val`/field bindings whose initializer is a
 *    jOOQ table reference, so `.from(TABLE)` / `.from(em)` resolve to the
 *    real table. This is what splits one DAO-per-file `val TABLE =
 *    DSL.table(...)` convention into distinct tables instead of collapsing
 *    every DAO onto a literal "TABLE".
 *  - fieldTypes: declared field / constructor-parameter types (Java
 *    `field_declaration`, Kotlin `property_declaration`/`class_parameter`),
 *    simple names only — the receiver's TYPE names the entity a repository
 *    call touches better than the field name does.
 */
function buildFilePrepass(root: Node): {
  tableAliases: Map<string, string>;
  fieldTypes: Map<string, string>;
  stringConsts: Map<string, string>;
  configFields: Map<string, { key: string; fallback?: string }>;
} {
  const tableAliases = new Map<string, string>();
  const fieldTypes = new Map<string, string>();
  const stringConsts = new Map<string, string>();
  const ctorStrings = new Map<string, string[]>();
  // Read once the whole file is walked, so a constant declared below its use still folds in.
  const stringFields: Array<{ name: string; value: Node }> = [];
  const ctorValues: Array<{ name: string; value: Node }> = [];
  const configFields = new Map<string, { key: string; fallback?: string }>();
  /** `@Value("${clubs.url:http://clubs}") String clubsUrl` — the configuration key a field or parameter holds. */
  const configOf = (decl: Node, name: string | null | undefined): void => {
    if (!name) return;
    const m = /@(?:\w+:)?Value\s*\(\s*(?:value\s*=\s*)?"\\?\$\{([^}:]+)(?::([^}]*))?\}"/.exec(decl.text);
    if (m && !configFields.has(name)) configFields.set(name, { key: m[1]!.trim(), ...(m[2] ? { fallback: m[2] } : {}) });
  };
  const putType = (name: string | null | undefined, rawType: string | null | undefined): void => {
    const type = simpleTypeName(rawType);
    if (name && type && !fieldTypes.has(name)) fieldTypes.set(name, type);
  };
  const visit = (n: Node): void => {
    let nameNode: Node | null = null;
    let initNode: Node | null = null;
    if (n.type === "property_declaration") {
      const { name, type } = kotlinNameAndType(n);
      putType(name, type);
      nameNode =
        findChild(n, "variable_declaration")?.children.find((c) => c.type === "simple_identifier") ?? null;
      initNode = initializerAfterEquals(n);
    } else if (n.type === "field_declaration" || n.type === "local_variable_declaration") {
      const vd = findChild(n, "variable_declarator");
      nameNode = vd?.childForFieldName("name") ?? null;
      initNode = vd?.childForFieldName("value") ?? null;
      if (n.type === "field_declaration") {
        // Java: one type, possibly several declarators.
        const rawType = n.childForFieldName("type")?.text;
        for (const c of n.children) {
          if (c.type !== "variable_declarator") continue;
          putType(c.childForFieldName("name")?.text, rawType);
          const value = c.childForFieldName("value");
          const name = c.childForFieldName("name")?.text;
          if (value && name && rawType === "String") stringFields.push({ name, value });
          configOf(n, name);
        }
      }
    } else if (n.type === "assignment_expression" && n.parent?.type === "expression_statement" && insideConstructor(n)) {
      // `this.select = "SELECT … FROM outbox LIMIT " + batchSize;` in a constructor: the field's query.
      const left = n.childForFieldName("left");
      const name = left?.type === "field_access" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("field")?.text : left?.type === "identifier" ? left.text : null;
      const value = n.childForFieldName("right");
      if (name && value) ctorValues.push({ name, value });
    } else if (n.type === "class_parameter") {
      // Kotlin primary-constructor `val x: Type`.
      const { name, type } = kotlinNameAndType(n);
      putType(name, type);
      configOf(n, name);
    } else if (n.type === "formal_parameter") {
      // `X(@Value("${clubs.url}") String clubsUrl)`: assigned to the field of that name, as a rule.
      configOf(n, n.childForFieldName("name")?.text);
    }
    if (n.type === "property_declaration") configOf(n, kotlinNameAndType(n).name);
    if (nameNode && initNode) {
      const table = resolveTableExpr(initNode, tableAliases);
      if (table) tableAliases.set(nameNode.text, table);
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  // Literal constants first, then those concatenated from them (`SELECT_ALL = "SELECT * FROM " + TABLE`).
  for (const { name, value } of stringFields) {
    if (value.type === "string_literal" || value.type === "text_block") stringConsts.set(name, stringArgText(value)!);
  }
  for (const { name, value } of stringFields) {
    const text = stringConsts.has(name) ? null : stringArgText(value, stringConsts);
    if (text) stringConsts.set(name, text);
  }
  for (const { name, value } of ctorValues) {
    if (fieldTypes.get(name) !== "String") continue;
    for (const text of stringArmTexts(value, stringConsts)) (ctorStrings.get(name) ?? ctorStrings.set(name, []).get(name)!).push(text);
  }
  // A field the constructor sets from a string is as good as a constant — set per
  // database dialect in branches, as long as every query it can hold names one table.
  for (const [name, texts] of ctorStrings) {
    if (stringConsts.has(name)) continue;
    const read = texts.filter((x) => constantQueryTarget(x));
    const tables = new Set(read.map((x) => constantQueryTarget(x)!.entity.toLowerCase()));
    if (tables.size === 1) stringConsts.set(name, read[0]!);
    else if (texts.length === 1) stringConsts.set(name, texts[0]!);
  }
  return { tableAliases, fieldTypes, stringConsts, configFields };
}

/** The node sits in a Java constructor's body. */
function insideConstructor(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (p.type === "constructor_declaration") return true;
    if (p.type === "method_declaration" || p.type === "class_body" || p.type === "lambda_expression") return false;
  }
  return false;
}

/** The expression node following the `=` of a Kotlin `property_declaration`. */
function initializerAfterEquals(n: Node): Node | null {
  const eq = n.children.findIndex((c) => c.type === "=");
  return eq >= 0 ? (n.children[eq + 1] ?? null) : null;
}

function findChild(node: Node, type: string): Node | null {
  return node.children.find((c) => c.type === type) ?? null;
}

/** Read the content of a Java/Kotlin string literal node (quotes stripped). */
function stringLiteralValue(node: Node | null): string | null {
  if (!node) return null;
  if (node.type !== "string_literal") return null;
  const raw = node.text;
  if (raw.includes("$")) return null; // interpolated — not a stable table name
  return raw.replace(/^["']+|["']+$/g, "");
}

/**
 * Calls handing a path literal to a method of the same object
 * (`post("/auth", body)`, `this.get("/clubs/" + id)`), each argument as the
 * URL it states or null (`FileAnalysis.pathArgCalls`): the core fills a
 * helper's `${path}` hole (`String url = apiUrl + API_PATH + path; http.doPost(url)`)
 * with it at every call site.
 */
export function extractJavaPathArgCalls(tree: Tree): PathArgCall[] {
  const out: PathArgCall[] = [];
  fileStringConsts = buildFilePrepass(tree.rootNode).stringConsts;
  for (const inv of tree.rootNode.descendantsOfType("method_invocation")) {
    if (!inv) continue;
    const object = inv.childForFieldName("object");
    if (object && object.type !== "this") continue;
    const callee = inv.childForFieldName("name")?.text;
    const argList = inv.childForFieldName("arguments");
    if (!callee || !argList) continue;
    const argNodes = argList.namedChildren.filter((a): a is Node => !!a && a.type !== "comment");
    const args = argNodes.map((a) => {
      if (a.type !== "string_literal" && a.type !== "additive_expression" && a.type !== "binary_expression" && a.type !== "identifier") return null;
      const url = urlExpression(a, inv, 0);
      // A local holding the URL (`String url = baseUrl() + "/api/queues/" + vHost(); get(url)`).
      return url && (/^\/|^[\w.-]+\//.test(url) || (a.type === "identifier" && /^(?:\$\{[^{}]*\})+\/\w/.test(url))) ? url : null;
    });
    if (args.some((a) => a !== null)) {
      const argNames = argNodes.map((a) => (a.type === "identifier" ? a.text : null));
      out.push({ callee, args, ...(argNames.some((n) => n !== null) ? { argNames } : {}), line: inv.startPosition.row + 1 });
    }
  }
  return out;
}

/** Inside a lambda or a local/anonymous class below `root`: its returns are not `root`'s. */
function insideNestedCallable(node: Node, root: Node): boolean {
  for (let at = node.parent; at && at.id !== root.id; at = at.parent) {
    if (at.type === "lambda_expression" || at.type === "class_body" || at.type === "method_declaration") return true;
  }
  return false;
}

/** `x.m(…)` with `x` declared (in the method, a lambda around it, or as a field) as a project-looking type: that type and method. */
function receiverMethod(call: Node, fieldType: (name: string) => string | null): { type: string; method: string } | null {
  if (call.type !== "method_invocation") return null;
  const object = call.childForFieldName("object");
  const method = call.childForFieldName("name")?.text;
  if (object?.type !== "identifier" || !method) return null;
  // A capitalized name nothing declares is the class itself (`SettingUtils.populateDefaultConfig(…)`, a static method).
  const declared = (declaredOutward(object, object.text) ?? fieldType(object.text) ?? (/^[A-Z]/.test(object.text) ? object.text : "")).replace(/<[\s\S]*$/, "").trim();
  return /^[A-Z][\w]*$/.test(declared) ? { type: declared, method } : null;
}

/** Steps that collect or unwrap what they are handed without changing its element: `collectList()`, `blockOptional(…)`, `orElseGet(List::of)`. */
const UNWRAPPING_STEPS = /^(?:collectList|collectSortedList|block|blockOptional|blockFirst|blockLast|orElse|orElseGet|orElseThrow|toList|toStream|toIterable|asList)$/;

/** The producing call of a chain, past the steps that keep or unwrap its element: `svc.roles(s).collectList().blockOptional(t).orElseGet(List::of)` → `svc.roles(s)`. */
function chainHead(value: Node): Node {
  let root: Node = value;
  while (root.type === "method_invocation" && root.childForFieldName("object")?.type === "method_invocation") {
    const step = root.childForFieldName("name")?.text ?? "";
    if (!KEEPING_STEPS.test(step) && !UNWRAPPING_STEPS.test(step)) break;
    root = root.childForFieldName("object")!;
  }
  return root;
}

/**
 * The method of another class whose result an extension-client write hands over: the argument
 * itself (`client.update(profile.user())`), the stream a lambda parameter is the element of
 * (`fetcher.getConfigMap().flatMap(cm -> client.update(cm))`, or a local holding it:
 * `var roles = svc.roles(s).collectList().block(); roles.forEach(r -> client.update(r))`),
 * or a local's initializer.
 */
function objectProducer(node: Node, arg: Node, fieldType: (name: string) => string | null): { type: string; method: string } | null {
  const direct = receiverMethod(arg, fieldType);
  if (direct || arg.type !== "identifier") return direct;
  return localProducer(node, arg.text, fieldType, true);
}

function localProducer(node: Node, name: string, fieldType: (name: string) => string | null, lambdas: boolean): { type: string; method: string } | null {
  for (let at: Node | null = node.parent; at; at = at.parent) {
    if (at.type === "lambda_expression" && lambdas) {
      const params = at.childForFieldName("parameters");
      const names = params ? (params.type === "identifier" ? [params.text] : params.descendantsOfType("identifier").map((n) => n?.text)) : [];
      if (!names.includes(name)) continue;
      const step = at.parent?.type === "argument_list" ? at.parent.parent : null;
      if (step?.type !== "method_invocation" || !ELEMENT_STEPS.test(step.childForFieldName("name")?.text ?? "")) return null;
      let root: Node | null | undefined = step.childForFieldName("object");
      while (root?.type === "method_invocation" && KEEPING_STEPS.test(root.childForFieldName("name")?.text ?? "") && root.childForFieldName("object")?.type === "method_invocation") {
        root = root.childForFieldName("object");
      }
      // A local holding the stream or its collected elements: its initializer's producing call.
      if (root?.type === "identifier") return localProducer(step, root.text, fieldType, false);
      return root ? receiverMethod(root, fieldType) : null;
    }
    if (/^(method_declaration|constructor_declaration)$/.test(at.type)) {
      for (const decl of at.descendantsOfType("variable_declarator")) {
        if (decl?.childForFieldName("name")?.text !== name) continue;
        const value = decl.childForFieldName("value");
        return value ? receiverMethod(chainHead(value), fieldType) : null;
      }
      return null;
    }
  }
  return null;
}
