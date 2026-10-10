import type { Node, Tree } from "web-tree-sitter";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
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

const JDBC_ACCESS = dbVerbTable(
  ["query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "getResultList", "getSingleResult"],
  ["update", "batchUpdate", "persist", "merge"],
);

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
  ["insertInto", "update", "deleteFrom", "mergeInto", "truncate"],
);

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

/**
 * The same DAO/Repository marker as a PREFIX — codebases that name repositories
 * `RepositoryClass` / fields `repositoryClass` instead of `ClassRepository`.
 * Whole words only (no bare `repo…`: `repoPath`, `repoUrl` are VCS vocabulary),
 * and a base naming a collaborator role rather than a record is vetoed —
 * `daoFactory` / `repositoryService` are not data access on "Factory"/"Service".
 */
const DAO_PREFIX_RE = /^(?:Repository|repository|DAO|Dao|dao)([A-Z]\w*)$/;
/** Declared receiver type that is a service-layer collaborator, not a data store. */
const SERVICE_LAYER_TYPE_RE = /(Service|ServiceImpl|Controller|Facade|Handler|Resource|Client|Api|Gateway|Manager|Helper|Component)$/;
const DAO_PREFIX_ROLE_VETO =
  /(Factory|Service|Manager|Provider|Helper|Registry|Impl|Client|Utils?|Url|Uri|Path|Name|Dir|Root)$/;

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

// ─── Typed application/domain events ─────────────────────────────────────────
// Frameworks that route messages by EVENT TYPE rather than a named queue:
// Spring application events (@EventListener/@TransactionalEventListener +
// publisher.publishEvent), Guava EventBus (@Subscribe + bus.post), Axon
// (@EventHandler), and typed event-framework handlers (@MessageHandler). The
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
// An event payload type: `AccountCreatedEvent`, `LoginMessage`, … The suffix
// fence keeps `emailPublisher.send(new Attachment())` from reading as an event.
const EVENT_TYPE_RE = /(Event|Message|Command|Notification)$/;

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

/** Join an optional client base path with a call path, with one leading `/`. */
function joinUrl(base: string | null, path: string): string {
  const parts = [base ?? "", path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + parts.join("/");
}

export class JavaKotlinDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  /**
   * file-local jOOQ table aliases: `private val TABLE = DSL.table("X")` /
   * `val em = Tables.EXTERNALMESSAGE` → `{ TABLE: "X", em: "EXTERNALMESSAGE" }`.
   * Rebuilt per file (each worker owns its extractor and runs `extract` to
   * completion before the next file, so a per-instance field is safe).
   */
  private tableAliases = new Map<string, string>();

  /** File declares a Feign client — its mapping annotations are outbound calls. */
  private isFeignFile = false;
  /** `@FeignClient(path = "/api/users")` prefix, prepended to method paths. */
  private feignBasePath: string | null = null;
  /**
   * File references jOOQ (org.jooq import or generated-tables package). The
   * jOOQ table branch only runs here — its generic verbs otherwise misread
   * `String.join(SOME_CONSTANT, …)` as a query on table SOME_CONSTANT.
   */
  private isJooqFile = false;
  /**
   * Declared field/constructor-parameter types (`accountJpaRepository` →
   * `AccountJpaRepository`). The TYPE names the entity more reliably than the
   * field name: `externalIdJpaRepository` is a FederatedIdentityJpaRepository.
   */
  private fieldTypes = new Map<string, string>();

  override beginFile(tree: Tree): void {
    const prepass = buildFilePrepass(tree.rootNode);
    this.tableAliases = prepass.tableAliases;
    this.fieldTypes = prepass.fieldTypes;
    const text = tree.rootNode.text;
    this.isFeignFile = text.includes("@FeignClient");
    this.feignBasePath = this.isFeignFile
      ? (text.match(/@FeignClient\s*\(([^)]*)\)/)?.[1]?.match(/path\s*=\s*"([^"]+)"/)?.[1] ?? null)
      : null;
    this.isJooqFile = /jooq/i.test(text);
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

      // Typed-event handlers: the subscribed event type is the destination —
      // named in the annotation (`@EventListener(X.class)`) or, in the common
      // `@MessageHandler void handle(XEvent event, Metadata md)` shape, the
      // handler's first parameter type.
      const evtListener = text.match(EVENT_LISTENER_ANN_RE);
      if (evtListener && !listener) {
        const annClass = text.match(EVENT_ANN_CLASS_RE)?.[1]?.split(".").pop();
        const target = annClass ?? handlerFirstParamType(node);
        if (target) {
          sources.push(this.ds({
            kind: "queue-consume",
            name: `@${evtListener[1]}`,
            target,
            line: node.startPosition.row + 1,
          }));
        }
      }

      // Retrofit: the verb annotation IS the outbound call declaration. The
      // path is emitted app-relative so the cross-tier route linker can join
      // it to the serving backend route.
      const retrofit = text.match(RETROFIT_ANN_RE);
      if (retrofit) {
        sources.push(this.ds({
          kind: "api-call",
          name: retrofit[1]!,
          target: joinUrl(null, retrofit[2]!),
          line: node.startPosition.row + 1,
        }));
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
          }));
        }
      }
    }
  }

  private classifyCall(node: Node, call: CallParts, sources: DataSourceInfo[]): void {
    const { method, receiver } = call;
    const line = node.startPosition.row + 1;

    // 1) jOOQ — table lives in the first argument. Only CONSUME the call when a
    // table is actually found; otherwise fall through, since a verb like
    // `update` is also a DAO method (`documentDAO.update(doc)`) handled below.
    // Gated on file-level jOOQ evidence: `join`/`from` + an ALL-CAPS constant
    // also describes `String.join(NAME_DELIMITER, …)`, which otherwise becomes
    // a phantom table. The receiver veto covers the same shape inside genuine
    // jOOQ files: a Capitalized bare-identifier receiver is a class (`String`,
    // `LocalDate`), never a query chain (`dsl…`, `DSL`, `STUDENT` stay eligible).
    if (this.isJooqFile && JOOQ_TABLE_VERBS.has(method) && !/^[A-Z][a-z]\w*$/.test(receiver.trim())) {
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

    // 2) DAO / Repository call — entity from the receiver's declared type when
    // the file declares it (`accountJpaRepository: AccountJpaRepository` →
    // Account), else from the receiver name (`caseDAO.get` → Case). Dominant
    // data path here: the DAO wraps jOOQ behind a factory, so this is where a
    // service method's DB access is visible.
    const daoEntity = daoReceiverEntity(receiver, this.fieldTypes);
    if (daoEntity && DAO_CRUD_RE.test(method)) {
      sources.push(this.ds({
        kind: "database",
        name: `DAO: ${method}`,
        target: daoEntity,
        entity: daoEntity,
        line,
        ...withAccess(jvmVerbAccess(method)),
      }));
      return;
    }

    // 3) Spring Data / JPA repository methods.
    // The receiver's declared type is the target when the file declares it
    // (`store.findByEmail` on a `UserStore` field → "UserStore"): whatever the
    // naming convention, the call then lands on a real repository node instead
    // of the shared "(unresolved)" bucket. A service-layer type is no store —
    // `userService.findAll()` in a controller merely shares Spring Data's verbs.
    if (SPRING_DATA_EXACT.has(method) || SPRING_DATA_DERIVED.test(method)) {
      const access = dbAccessFor(method, SPRING_DATA_ACCESS) ?? jvmVerbAccess(method);
      const seg = receiver.split(".").pop()?.trim() ?? "";
      const declared = /^[\w$]+$/.test(seg)
        ? (localDeclaredType(node, seg) ?? this.fieldTypes.get(seg) ?? null)
        : null;
      // A service receiver (`personService.save(cmd)`) is a call into the
      // service layer, where the access — if any — is visible in its own
      // right; a bare `save(x)` / `getByCivicNumber(id)` is a call on this
      // class, which the linker follows to its definition. Neither is a data
      // access here: emitting them put a target-less "database" row on two
      // thirds of eos's service methods.
      if (!seg || (declared && SERVICE_LAYER_TYPE_RE.test(declared))) return;
      sources.push(this.ds({ kind: "database", name: method, target: declared, line, ...withAccess(access) }));
      return;
    }

    // 4) JdbcTemplate / EntityManager — generic names, gated on receiver. The
    // entity is the class literal JPA takes (`find(Person.class, id)`,
    // `createNamedQuery("…", Person.class)`, `createQuery(jpql, Person.class)`)
    // or the `from Person` of a JPQL/HQL string; a criteria query
    // (`createQuery(cq)`) names none.
    if (JDBC_METHODS.has(method) && JDBC_RECEIVER_RE.test(receiver)) {
      const entity = jpaEntityArg(node);
      sources.push(this.ds({
        kind: "database",
        name: method,
        target: entity,
        ...(entity ? { entity } : {}),
        line,
        ...withAccess(dbAccessFor(method, JDBC_ACCESS)),
      }));
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

    // 5b) Typed-event publish — `eventPublisher.send(audit, meta, message)` /
    // `springPublisher.publishEvent(new SourceIngestedEvent(x))` /
    // `eventBus.post(event)`. The destination is the event's TYPE, resolved
    // from a `new X(...)` / `X.newBuilder()` argument or the declared type of
    // an identifier argument (rightmost event-shaped argument wins — typed
    // event frameworks put audit/metadata first, payload last).
    if (EVENT_PUBLISH_METHODS.has(method)) {
      const recvLeaf = receiver.split(".").pop()?.trim() ?? "";
      if (method === "publishEvent" || EVENT_PUBLISHER_RECEIVER_RE.test(recvLeaf)) {
        const evt = this.resolveEventArg(node, method === "publishEvent");
        if (evt) {
          sources.push(this.ds({
            kind: "queue-publish",
            name: `EVT: ${method}`,
            target: evt,
            line,
          }));
          return;
        }
      }
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

  /**
   * Event type published by this call, scanning arguments right-to-left:
   * `new AccountCreatedEvent(…)` → AccountCreatedEvent;
   * `AccountUpdateMessage.newBuilder()…build()` → AccountUpdateMessage;
   * a bare identifier → its declared local/parameter/field type.
   * Non-`publishEvent` verbs require the EVENT_TYPE_RE suffix (`relaxed`
   * lifts that for constructor args of the unambiguous `publishEvent`).
   */
  private resolveEventArg(call: Node, relaxed: boolean): string | null {
    const args = callArguments(call);
    for (let i = args.length - 1; i >= 0; i--) {
      const arg = args[i]!;

      // Constructed or builder-built payload: Java `new X(...)`, Kotlin
      // `X(...)`, or a builder chain rooted at the type (`X.newBuilder()…`).
      const text = arg.text;
      const ctorType =
        arg.type === "object_creation_expression"
          ? simpleTypeName(arg.childForFieldName("type")?.text)
          : arg.type === "call_expression" && /^[A-Z]\w*\s*\(/.test(text)
            ? simpleTypeName(text.slice(0, text.indexOf("(")))
            : text.match(/^([A-Z]\w*)\s*\.\s*newBuilder\b/)?.[1] ?? null;
      if (ctorType && (relaxed || EVENT_TYPE_RE.test(ctorType))) return ctorType;

      // Identifier: resolve the declared type — enclosing-method local or
      // parameter first, then a class field. Always suffix-fenced: without a
      // constructor in sight the type is the only event-shaped evidence.
      if (/^[\w$]+$/.test(text)) {
        const t = localDeclaredType(call, text) ?? this.fieldTypes.get(text) ?? null;
        if (t && EVENT_TYPE_RE.test(t)) return t;
      }
    }
    return null;
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
/** The entity a JPA call names: a `X.class` argument, else `from X` inside a string argument. */
function jpaEntityArg(node: Node): string | null {
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "call_suffix" || c.type === "value_arguments");
  const text = args?.text ?? "";
  const literal = /\b([A-Z]\w*)(?:\.class|::class(?:\.java)?)\b/.exec(text);
  if (literal) return literal[1]!;
  const jpql = /["']\s*(?:select\b[^"']*?)?\bfrom\s+([A-Z]\w*)\b/i.exec(text);
  return jpql && /^[A-Z]/.test(jpql[1]!) ? jpql[1]! : null;
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
 * `externalIdJpaRepository` of type `FederatedIdentityJpaRepository` accesses
 * FederatedIdentity, which only the type knows. Otherwise the receiver name is
 * used (`this.caseDAO` → "case"). In both, the `DAO`/`Repository` suffix is
 * stripped, plus a residual persistence-tech suffix (`AccountJpaRepository` →
 * `AccountJpa` → `Account`) and an interface-convention `I` prefix
 * (`ICaseDAO` → `Case`). The prefix convention works the same way
 * (`RepositoryClass` → `Class`). Null when the receiver isn't a DAO.
 */
function daoReceiverEntity(receiver: string, fieldTypes?: Map<string, string>): string | null {
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
function callArguments(call: Node): Node[] {
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
function localDeclaredType(node: Node, name: string): string | null {
  let fn: Node | null = node.parent;
  while (fn && !/^(method_declaration|constructor_declaration|function_declaration|lambda_expression|lambda_literal)$/.test(fn.type)) {
    fn = fn.parent;
  }
  if (!fn) return null;

  const scan = (n: Node): string | null => {
    if (n.type === "local_variable_declaration") {
      for (const c of n.children) {
        if (c.type === "variable_declarator" && c.childForFieldName("name")?.text === name) {
          return simpleTypeName(n.childForFieldName("type")?.text);
        }
      }
    } else if (n.type === "property_declaration") {
      const kt = kotlinNameAndType(n);
      if (kt.name === name) return simpleTypeName(kt.type);
    } else if (n.type === "formal_parameter" || n.type === "parameter") {
      const kt = kotlinNameAndType(n);
      const pName = n.childForFieldName("name")?.text ?? kt.name;
      if (pName === name) {
        return simpleTypeName(n.childForFieldName("type")?.text ?? kt.type);
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

/**
 * Subscribed event type of the method a listener annotation decorates —
 * `@MessageHandler void handle(ElementUpdatedEvent event, Metadata md)` →
 * ElementUpdatedEvent. Prefers the parameter whose type is event-shaped
 * (frameworks pass audit/metadata alongside the payload — e.g.
 * `handle(AuditInformation a, Metadata m, LoginMessage msg)`), falling back to
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
  return types.find((t) => EVENT_TYPE_RE.test(t)) ?? types[0] ?? null;
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
} {
  const tableAliases = new Map<string, string>();
  const fieldTypes = new Map<string, string>();
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
          if (c.type === "variable_declarator") putType(c.childForFieldName("name")?.text, rawType);
        }
      }
    } else if (n.type === "class_parameter") {
      // Kotlin primary-constructor `val x: Type`.
      const { name, type } = kotlinNameAndType(n);
      putType(name, type);
    }
    if (nameNode && initNode) {
      const table = resolveTableExpr(initNode, tableAliases);
      if (table) tableAliases.set(nameNode.text, table);
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return { tableAliases, fieldTypes };
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
