import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

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
  "selectFrom", "insertInto", "update", "deleteFrom", "mergeInto",
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
const JDBC_METHODS = new Set([
  "query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet",
  "update", "batchUpdate", "execute",
  "createQuery", "createNativeQuery", "createNamedQuery",
  "getResultList", "getSingleResult", "persist", "merge",
]);
const JDBC_RECEIVER_RE = /jdbc|template|entitymanager|^em$|session/i;

/** HTTP-client hints anywhere in the call text, plus Spring REST method names. */
const HTTP_HINT_RE = /RestTemplate|WebClient|HttpClient|OkHttpClient|Retrofit/;
const HTTP_METHODS = new Set([
  "exchange", "getForObject", "getForEntity",
  "postForObject", "postForEntity", "postForLocation",
  "retrieve",
]);

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

// Consume side: listener annotations. Destination attribute per flavor:
// @RabbitListener(queues = "q"), @KafkaListener(topics = {"t1","t2"}),
// @JmsListener(destination = "d"). Kotlin writes arrays as ["t"].
const MQ_LISTENER_RE = /@(RabbitListener|KafkaListener|JmsListener)\b/;
const MQ_LISTENER_DEST_RE = /(?:queues|topics|destination|queueNames)\s*=\s*[[{]?\s*"([^"]+)"/;

export class JavaKotlinDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  /**
   * file-local jOOQ table aliases: `private val TABLE = DSL.table("X")` /
   * `val em = Tables.EXTERNALMESSAGE` → `{ TABLE: "X", em: "EXTERNALMESSAGE" }`.
   * Rebuilt per file (each worker owns its extractor and runs `extract` to
   * completion before the next file, so a per-instance field is safe).
   */
  private tableAliases = new Map<string, string>();

  override beginFile(tree: Tree): void {
    this.tableAliases = buildTableAliases(tree.rootNode);
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "method_invocation" || node.type === "call_expression") {
      const call = resolveCall(node);
      if (call) this.classifyCall(node, call, sources);
    }

    // @Autowired / @Inject / @Value annotations indicate dependency injection.
    if (node.type === "annotation" || node.type === "marker_annotation") {
      const text = node.text;
      if (text.includes("Autowired") || text.includes("Inject") || text.includes("Value")) {
        sources.push(this.ds({
          kind: "import",
          name: text.replace(/^@/, ""),
          target: null,
          line: node.startPosition.row + 1,
        }));
      }

      // Listener annotations mark the consume side of a message flow:
      // the annotated method is the broker's entry point into this file.
      const listener = text.match(MQ_LISTENER_RE);
      if (listener) {
        sources.push(this.ds({
          kind: "queue-consume",
          name: `@${listener[1]}`,
          target: text.match(MQ_LISTENER_DEST_RE)?.[1] ?? null,
          line: node.startPosition.row + 1,
        }));
      }
    }
  }

  private classifyCall(node: Node, call: CallParts, sources: DataSourceInfo[]): void {
    const { method, receiver } = call;
    const line = node.startPosition.row + 1;

    // 1) jOOQ — table lives in the first argument. Only CONSUME the call when a
    // table is actually found; otherwise fall through, since a verb like
    // `update` is also a DAO method (`documentDAO.update(doc)`) handled below.
    if (JOOQ_TABLE_VERBS.has(method)) {
      const table = resolveTableExpr(call.firstArg, this.tableAliases);
      if (table) {
        sources.push(this.ds({
          kind: "database",
          name: `jOOQ: ${method}`,
          target: table,
          entity: table,
          line,
        }));
        return;
      }
    }

    // 2) DAO / Repository call — entity from the receiver name (`caseDAO.get` →
    // Case). Dominant data path here: the DAO wraps jOOQ behind a factory, so
    // this is where a service method's DB access is visible.
    const daoEntity = daoReceiverEntity(receiver);
    if (daoEntity && DAO_CRUD_RE.test(method)) {
      sources.push(this.ds({
        kind: "database",
        name: `DAO: ${method}`,
        target: daoEntity,
        entity: daoEntity,
        line,
      }));
      return;
    }

    // 3) Spring Data / JPA repository methods.
    if (SPRING_DATA_EXACT.has(method) || SPRING_DATA_DERIVED.test(method)) {
      sources.push(this.ds({ kind: "database", name: method, target: null, line }));
      return;
    }

    // 4) JdbcTemplate / EntityManager — generic names, gated on receiver.
    if (JDBC_METHODS.has(method) && JDBC_RECEIVER_RE.test(receiver)) {
      sources.push(this.ds({ kind: "database", name: method, target: null, line }));
      return;
    }

    // 5) Message-queue publish — rabbitTemplate.convertAndSend(exchange, key,
    // payload) / kafkaTemplate.send(topic, msg). The first argument names the
    // destination; a string literal is unquoted, any other expression's source
    // text is kept as a join label.
    if (MQ_TEMPLATE_PUBLISH.has(method) && MQ_TEMPLATE_RECEIVER_RE.test(receiver)) {
      sources.push(this.ds({
        kind: "queue-publish",
        name: `MQ: ${method}`,
        target: destinationLabel(call.firstArg),
        line,
      }));
      return;
    }

    // 6) HTTP client calls.
    if (HTTP_METHODS.has(method) || HTTP_HINT_RE.test(node.text)) {
      sources.push(this.ds({ kind: "api-call", name: method, target: null, line }));
      return;
    }

    // 7) Environment / config reads.
    if (method === "getProperty" || method === "getenv") {
      sources.push(this.ds({ kind: "env", name: method, target: null, line }));
    }
  }
}

/**
 * Broker-destination label from a template call's first argument: a string
 * literal's unquoted value, or any other expression's source text
 * (`RabbitConfig.ORDERS_EXCHANGE`) — still a usable join key.
 */
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
 * Entity behind a DAO/Repository receiver: the last receiver segment with a
 * `DAO`/`Dao`/`Repository`/`Repo` suffix stripped (`this.caseDAO` → "case",
 * `reimbursementDAO` → "reimbursement"). Null when the receiver isn't a DAO.
 */
function daoReceiverEntity(receiver: string): string | null {
  const seg = receiver.split(".").pop()?.trim() ?? "";
  const m = DAO_RECEIVER_RE.exec(seg);
  const base = m?.[1];
  return base && base.length > 1 ? base : null;
}

/** Receiver node of a `recv.method(...)` call (Java `object` field / Kotlin navigation). */
function receiverNode(call: Node): Node | null {
  if (call.type === "method_invocation") return call.childForFieldName("object");
  const callee = call.child(0);
  return callee?.type === "navigation_expression" ? callee.child(0) : null;
}

/**
 * Pre-pass: index file-local `val`/field bindings whose initializer is a jOOQ
 * table reference, so `.from(TABLE)` / `.from(em)` resolve to the real table.
 * This is what splits one DAO-per-file `val TABLE = DSL.table(...)` convention
 * into distinct tables instead of collapsing every DAO onto a literal "TABLE".
 */
function buildTableAliases(root: Node): Map<string, string> {
  const aliases = new Map<string, string>();
  const visit = (n: Node): void => {
    let nameNode: Node | null = null;
    let initNode: Node | null = null;
    if (n.type === "property_declaration") {
      nameNode =
        findChild(n, "variable_declaration")?.children.find((c) => c.type === "simple_identifier") ?? null;
      initNode = initializerAfterEquals(n);
    } else if (n.type === "field_declaration" || n.type === "local_variable_declaration") {
      const vd = findChild(n, "variable_declarator");
      nameNode = vd?.childForFieldName("name") ?? null;
      initNode = vd?.childForFieldName("value") ?? null;
    }
    if (nameNode && initNode) {
      const table = resolveTableExpr(initNode, aliases);
      if (table) aliases.set(nameNode.text, table);
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return aliases;
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
