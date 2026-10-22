import { responseReadsOf, type BodyStyle } from "./response-reads.js";
import { resolveRtkHooks } from "./rtk-query.js";
import { resolveKubbClientCalls } from "./kubb.js";
import type { Node, Tree } from "web-tree-sitter";
import type { Confidence, DataSourceInfo, CallInfo, FileAnalysis, JsonSchemaNode, Language } from "../../../types/analysis.js";
import { DataSourceExtractor, type ProjectApiCall } from "../../data-sources/base.js";
import type { ProjectContext } from "../../../types/project.js";
import { resolveUrlBuilders } from "./url-builders.js";
import { extractCalls } from "../../shared/call-graph.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { escapeRegex } from "../shared/path-utils.js";
import { foldValue, toAppRelativeUrl } from "../../shared/value-resolver.js";
import { astToValueExpr, buildScope } from "./value-capture.js";
import { npmPackages } from "./packages.js";
import { extractGqlOperationCalls } from "../shared/graphql-operations.js";
import { GENERATED_CLIENT_MARKER, generatedClientCall } from "./generated-clients.js";
import { tableFrom } from "../shared/sql-string-sources.js";
import { sqlVerbAccess } from "../shared/db-access.js";

/** A resolved api-call URL: the app-relative path plus recovered provenance. */
interface ResolvedUrl {
  url: string;
  /** The other values the URL can take (a local set by a ternary or in each branch of an `if`). */
  alternatives?: string[];
  baseEnv?: string;
  confidence: Confidence;
}

/** Named HTTP clients — trusted as API calls without a URL-shape check. */
const HTTP_ROOTS = new Set(["fetch", "axios", "http", "request", "ajax"]);

/**
 * HTTP "verb" methods. These collide with non-HTTP APIs (`Map.get`,
 * `URLSearchParams.get`, `array.includes`), so a verb call is only an API call
 * when its argument is URL-shaped — see `looksLikeUrl`.
 *
 * `del` is here because `delete` is a reserved word: superagent, koa-route and
 * several wrappers spell the DELETE verb `del`, and a client that wraps them
 * (`const requests = { del: url => superagent.del(...) }`) inherits the name.
 * Leaving it out silently dropped every DELETE call in a codebase — the accuracy
 * eval found exactly that on the RealWorld frontend, where `get`/`post`/`put`
 * all resolved and all four DELETEs went missing.
 */
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "del"]);

/** React hook patterns that indicate data sources */
const STATE_HOOKS = new Set([
  "useState", "useReducer", "useRef", "useMemo",
  "useCallback", "useDeferredValue", "useTransition",
  "useSyncExternalStore",
]);

const CONTEXT_HOOKS = new Set(["useContext"]);

const STORE_HOOKS = new Set([
  "useSelector", "useStore", "useDispatch",
  "useRecoilValue", "useAtom",
  "useQuery", "useSWR", "useSWRImmutable", "useInfiniteQuery", "useMutation",
  // Pinia / Vuex
  "defineStore", "storeToRefs",
]);

/** Vue Composition API reactive sources */
const VUE_COMPOSITION_SOURCES = new Set([
  "ref", "reactive", "computed", "shallowRef",
  "shallowReactive", "readonly", "toRef", "toRefs", "customRef",
]);

/** Vue Composition API watchers */
const VUE_WATCHERS = new Set([
  "watch", "watchEffect", "watchPostEffect", "watchSyncEffect",
]);

/** Vue Composition API lifecycle hooks */
const VUE_LIFECYCLE = new Set([
  "onMounted", "onUpdated", "onUnmounted",
  "onBeforeMount", "onBeforeUpdate", "onBeforeUnmount",
  "onErrorCaptured", "onActivated", "onDeactivated", "onServerPrefetch",
]);

/** Vue <script setup> compiler macros */
const VUE_MACROS = new Set([
  "defineProps", "defineEmits", "defineExpose",
  "defineOptions", "defineModel", "defineSlots", "withDefaults",
]);

/**
 * Generic ORM root identifiers — a call whose chain starts with one of these is
 * a DB op regardless of the leaf method (`db.prepare("sql").all()`,
 * `prisma.user.findMany()`). Model classes (`Product`, `User`) are recognised
 * generically by {@link isModelLikeRoot}, not hardcoded here.
 */
const ORM_ROOTS = new Set(["prisma", "db", "client"]);

/** The packages the plugin's catalog files as ORMs or database drivers: importing one is ORM evidence. */
const ORM_PACKAGES = new Set(npmPackages.filter((r) => r.category === "orm" || r.category === "database").flatMap((r) => r.names ?? []));

/** `@scope/pkg/sub` → `@scope/pkg`, `drizzle-orm/pg-core` → `drizzle-orm`. */
function packageOf(source: string): string {
  const segs = source.split("/");
  return source.startsWith("@") ? segs.slice(0, 2).join("/") : segs[0]!;
}

/** What a file's imports tell the ORM-evidence gate, read once from its text. */
interface ImportEvidence {
  /** It imports an ORM or database driver. */
  orm: boolean;
  /** Every name an import or `require` binds. */
  names: Set<string>;
  /** Capitalized names imported from a `models/` path or declared as a model class: local models. */
  models: Set<string>;
}

function importEvidence(src: string): ImportEvidence {
  const evidence: ImportEvidence = { orm: false, names: new Set(), models: new Set() };
  const bind = (list: string, source: string, separator: RegExp): void => {
    if (ORM_PACKAGES.has(packageOf(source))) evidence.orm = true;
    const fromModels = /\bmodels?\b/.test(source);
    for (const part of list.replace(/[{}]|\*\s+as\s+/g, ",").split(",")) {
      const name = part.trim().split(separator).pop()?.trim();
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      evidence.names.add(name);
      if (fromModels && /^[A-Z]/.test(name)) evidence.models.add(name);
    }
  };
  for (const m of src.matchAll(/\bimport\s+(?:type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) bind(m[1]!, m[2]!, /\s+as\s+/);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]/g)) bind(m[1]!, m[2]!, /:/);
  for (const m of src.matchAll(/\bclass\s+([A-Z]\w*)\s+extends\s+(?:Model|BaseEntity|Entity)\b/g)) evidence.models.add(m[1]!);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Z]\w*)\s*=\s*(?:mongoose\.)?model\s*\(/g)) evidence.models.add(m[1]!);
  return evidence;
}

/** A segment that names a database handle: `ctx.knex`, `this.orm`. */
const ORM_HANDLE_SEGMENT = /^(?:db|knex|sequelize|mongoose|drizzle|kysely|orm)$/;

/**
 * ORM evidence in a receiver chain itself: a trusted root (`prisma`, `db`, a
 * `*Repository`), or a repository/model/handle-shaped segment before the verb
 * (`ctx.prisma.user`, `this.userRepo`, `ctx.knex`).
 */
function chainHasOrmEvidence(parts: readonly string[]): boolean {
  if (ORM_ROOTS.has(parts[0]!) || /Repository$/.test(parts[0]!)) return true;
  return parts.slice(0, -1).some((seg) => ORM_ROOTS.has(seg) || ORM_SEGMENT_RE.test(seg) || ORM_HANDLE_SEGMENT.test(seg));
}

/**
 * Driver methods that take raw SQL as their first argument: node-postgres and
 * mysql2 (`query`, `execute`), better-sqlite3 / sqlite (`prepare`, `exec`,
 * `run`, `all`, `get`), pg-promise (`any`, `one`, `oneOrNone`, `many`,
 * `none`, `manyOrNone`), Knex/Sequelize/Prisma escapes (`raw`, `$queryRaw…`),
 * postgres.js (`sql.unsafe`).
 * The verb alone proves nothing (`Map.get`, `router.all`); the SQL literal it
 * is handed does.
 */
const RAW_SQL_VERBS = new Set([
  "query", "execute", "exec", "prepare", "run", "all", "get",
  "any", "one", "oneOrNone", "many", "manyOrNone", "none",
  "raw", "unsafe", "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe",
]);

/** The literal must OPEN with a statement — `tableFrom` alone would read "Select a file from the list". */
const SQL_OPENER = /^\s*\(?\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|MERGE|TRUNCATE)\b/i;

/**
 * The table and access of raw SQL handed to a driver call, or null. A template
 * literal's substitutions become `?` (only the SQL around them matters).
 */
function rawSqlAccess(firstArg: Node | null): { table: string; access?: "read" | "write" } | null {
  if (!firstArg || (firstArg.type !== "string" && firstArg.type !== "template_string")) return null;
  const text = stripQuotes(firstArg.type === "template_string" ? firstArg.text.replace(/\$\{[^}]*\}/g, "?") : firstArg.text);
  if (!SQL_OPENER.test(text)) return null;
  const found = tableFrom(text);
  if (!found) return null;
  const table = found.table.split(".").pop()!;
  const access = sqlVerbAccess(found.verb);
  return { table, ...(access ? { access } : {}) };
}

/** Kysely query-builder clause verbs whose first argument names the table. */
const KYSELY_TABLE_VERBS = new Set(["selectFrom", "insertInto", "updateTable", "deleteFrom", "replaceInto", "mergeInto"]);

/** ORM method names that are unambiguously database operations. */
const ORM_METHODS = new Set([
  // Prisma
  "findUnique", "findFirst", "findMany", "create", "createMany",
  "update", "updateMany", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy",
  // TypeORM / Sequelize / Mongoose
  "findOne", "findAll", "findByPk", "findOrCreate", "save", "remove", "destroy",
  "bulkCreate", "bulkUpdate", "bulkDelete",
  // Mongoose finder/mutator family — these collide with no JS builtin or Array
  // method, so they're unambiguous DB ops on any receiver (`Model.findById(id)`,
  // `Model.findByIdAndUpdate(...)`, `Model.countDocuments()`).
  "findById", "findByIdAndUpdate", "findByIdAndDelete", "findByIdAndRemove",
  "findOneAndUpdate", "findOneAndDelete", "findOneAndRemove", "findOneAndReplace",
  "updateOne", "deleteOne", "replaceOne", "insertMany", "bulkWrite",
  "countDocuments", "estimatedDocumentCount", "distinct",
  // Drizzle's `get`/`all`/`values`/`execute`/`returning` are NOT here: they
  // collide with Map.get / Array-ish leaves on arbitrary receivers (phantom
  // `this.__data__.get` "entities" from lodash internals). On a trusted ORM
  // root (`db`, `prisma`, `*Repository`) ANY leaf already classifies as DB via
  // the trustedRoot fallthrough in isOrmCall, so real Drizzle chains still count.
  // Knex / query builder — bare `join` is dropped too (Array.prototype.join).
  "insert", "del", "where", "leftJoin", "rightJoin",
]);

/**
 * ORM methods that MUTATE (a subset of {@link ORM_METHODS}). Used to tag a
 * database data source's read/write nature so the dataflow-lite reach pass can
 * answer "which endpoints reach a DB write". The verb knowledge lives here in
 * the plugin, never in core. A leaf not in either set stays unclassified (the
 * reach pass keeps it as the coarse `db` effect).
 */
const ORM_WRITE_METHODS = new Set([
  "create", "createMany", "update", "updateMany", "upsert",
  "delete", "deleteMany", "save", "remove", "destroy",
  "bulkCreate", "bulkUpdate", "bulkDelete",
  "findByIdAndUpdate", "findByIdAndDelete", "findByIdAndRemove",
  "findOneAndUpdate", "findOneAndDelete", "findOneAndRemove", "findOneAndReplace",
  "updateOne", "deleteOne", "replaceOne", "insertMany", "bulkWrite",
  "insert", "del",
]);

/** What a loaded or constructed ORM document does to its own row (`club.save()`, `club.deleteOne()`). */
const DOCUMENT_WRITES = new Set(["save", "remove", "deleteOne", "updateOne", "destroy"]);

/** Model queries that hand back a document of that model. */
const DOCUMENT_LOADS = /^(?:findById|findOne|findByPk|findOrCreate|create|findOneAndUpdate|findByIdAndUpdate|build)$/;

/**
 * The model a local holds, by its declaration in the enclosing function: `new Club({…})`,
 * `await Club.findById(id)` / `Club.findOne({…})`. Null when the declaration says nothing.
 */
function localDocumentModel(node: Node, name: string): string | null {
  let scope: Node | null = node.parent;
  while (scope && !/^(?:function_declaration|function_expression|arrow_function|method_definition|program)$/.test(scope.type)) scope = scope.parent;
  if (!scope) return null;
  for (const decl of scope.descendantsOfType("variable_declarator")) {
    if (decl?.childForFieldName("name")?.text !== name) continue;
    let value = decl.childForFieldName("value");
    if (value?.type === "await_expression") value = value.namedChild(0);
    if (value?.type === "new_expression") {
      const ctor = value.childForFieldName("constructor");
      return ctor?.type === "identifier" && /^[A-Z]/.test(ctor.text) ? ctor.text : null;
    }
    const fn = value?.type === "call_expression" ? value.childForFieldName("function") : null;
    // `Club.findById(id).populate("owner")`: the load is the chain's first call.
    let call: Node | null | undefined = fn;
    while (call?.type === "member_expression" && call.childForFieldName("object")?.type === "call_expression") call = call.childForFieldName("object")!.childForFieldName("function");
    if (call?.type === "member_expression") {
      const obj = call.childForFieldName("object");
      const prop = call.childForFieldName("property")?.text ?? "";
      if (obj?.type === "identifier" && /^[A-Z]/.test(obj.text) && DOCUMENT_LOADS.test(prop)) return obj.text;
    }
    return null;
  }
  return null;
}

/** Classify a DB op's leaf method as read/write when known; undefined otherwise. */
function ormAccessKind(leaf: string): "read" | "write" | undefined {
  if (ORM_WRITE_METHODS.has(leaf)) return "write";
  if (ORM_METHODS.has(leaf)) return "read";
  return undefined;
}

// ─── Message queues (amqplib + kafkajs) ─────────────────────────────────────
// `sendToQueue` exists only on an amqplib channel, so the name alone is
// trusted. `publish`/`consume` are common words — they need a channel-shaped
// receiver. kafkajs verbs (`send`/`subscribe`) are gated on producer/consumer
// receivers plus the `{ topic }` descriptor shape.

/** Immediate receiver that reads like an AMQP channel (`ch`, `channel`, `this.channel`). */
const MQ_CHANNEL_RECEIVER_RE = /^ch$|channel/i;
const MQ_PRODUCER_RECEIVER_RE = /producer/i;
const MQ_CONSUMER_RECEIVER_RE = /consumer/i;

// ─── Job queues (BullMQ / Bull) and Socket.IO events ───────────────────────
// Both are gated on the file importing the library. A BullMQ `add` is a
// publish only on a receiver the file binds to a queue (`new Queue("emails")`,
// NestJS `@InjectQueue("audio") private audio: Queue`), which also names the
// queue; Socket.IO `emit`/`on` only on a socket-shaped receiver, and never for
// the library's own lifecycle events.

const BULL_IMPORT_RE = /(?:from\s*|require\(\s*)['"](?:bullmq|bull|@nestjs\/bullmq|@nestjs\/bull)['"]/;
const SOCKET_IO_IMPORT_RE = /(?:from\s*|require\(\s*)['"]socket\.io(?:-client)?['"]/;
const SOCKET_RECEIVER_RE = /socket|^io$|^client$|^server$|^nsp$|namespace/i;
const SOCKET_IO_RESERVED = new Set([
  "connect", "connection", "connect_error", "disconnect", "disconnecting", "error", "reconnect",
  "reconnect_attempt", "reconnect_error", "reconnect_failed", "reconnecting", "ping", "pong", "newListener", "removeListener",
]);

/** An RTK Query API slice: the file builds one, and the base its `fetchBaseQuery` names. */
function rtkEvidence(src: string): { slice: boolean; base: string } {
  const slice = /\bcreateApi\s*\(|\.injectEndpoints\s*\(/.test(src);
  const base = slice ? /fetchBaseQuery\s*\(\s*\{[^}]*?\bbaseUrl\s*:\s*['"`]([^'"`$]*)['"`]/.exec(src)?.[1] ?? "" : "";
  return { slice, base };
}

/** The name `{ refetch }` / `{ refetch: reload }` binds in a destructured query result. */
function refetchBinding(pattern: Node): Node | null {
  for (const p of pattern.namedChildren) {
    if (p.type === "shorthand_property_identifier_pattern" && p.text === "refetch") return p;
    if (p.type === "pair_pattern" && p.childForFieldName("key")?.text === "refetch") {
      const v = p.childForFieldName("value");
      return v?.type === "identifier" ? v : null;
    }
  }
  return null;
}

/** What a function returns: its expression body, or the value of every `return` in its block (nested functions left out). */
function returnedValues(fn: Node): Node[] {
  const body = fn.childForFieldName("body");
  if (!body) return [];
  if (body.type !== "statement_block") {
    const value = body.type === "parenthesized_expression" ? body.namedChild(0) : body;
    return value ? [value] : [];
  }
  const out: Node[] = [];
  const walk = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (c.type === "return_statement") {
        const v = c.namedChild(0);
        if (v) out.push(v.type === "parenthesized_expression" ? v.namedChild(0) ?? v : v);
      } else if (!FUNCTION_SCOPES.has(c.type)) walk(c);
    }
  };
  walk(body);
  return out;
}

/** The fields the caller reads off this call's response (response-reads.ts), by how its client hands the body over. */
function readsFor(node: Node, fnName: string): { responseReads?: string[] } {
  const style: BodyStyle = /^(?:fetch|ky)$/i.test(fnName) ? "json" : /^(?:\$fetch|ofetch)$/.test(fnName) ? "direct" : "data";
  const reads = responseReadsOf(node, style);
  return reads ? { responseReads: reads } : {};
}

/** A tRPC client call's verb → the HTTP method its link sends (subscriptions go over a socket). */
const TRPC_CLIENT_VERBS = new Map<string, string>([
  ...["query", "useQuery", "useSuspenseQuery", "useInfiniteQuery", "useSuspenseInfiniteQuery", "queryOptions", "infiniteQueryOptions",
    "fetch", "prefetch", "fetchInfinite", "prefetchInfinite", "ensureData"].map((v) => [v, "GET"] as const),
  ...["mutate", "mutateAsync", "useMutation", "mutationOptions"].map((v) => [v, "POST"] as const),
]);

interface MqEvidence {
  /** Queue name by the receiver holding it; null when the file does not import Bull/BullMQ. */
  bullQueues: Map<string, string> | null;
  socketIo: boolean;
  /** The file imports NestJS's event emitter (`@nestjs/event-emitter`). */
  nestEvents: boolean;
  /** Receivers the file creates as an in-process emitter (`new EventEmitter()`, `mitt()`), or `this` in a class extending one. */
  emitters: Set<string>;
  /** The file imports a Redis client (`redis`, `ioredis`). */
  redis: boolean;
}

/**
 * The emitter receivers a file creates: `const bus = new EventEmitter()`,
 * `export const events = mitt()`, and `this` in a class that extends
 * EventEmitter. A name read elsewhere (`import { bus } from "./events"`)
 * counts when it reads like one (`bus`, `emitter`, `eventBus`, `events`).
 */
function emitterReceivers(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:\w+\.)?EventEmitter\d*\b|mitt\s*\()/g)) out.add(m[1]!);
  if (/\bclass\s+\w+\s+extends\s+(?:\w+\.)?EventEmitter\b/.test(src)) out.add("this");
  return out;
}
/** A receiver name that reads like an in-process event bus. */
const EMITTER_NAME_RE = /^(?:bus|emitter|events|eventBus|eventEmitter|eventHub|eventManager|hub|pubsub)$|EventBus$|Emitter$|EventManager$/;
/** Receivers whose `on`/`emit` are never a message channel: the process, HTTP objects, streams, the DOM. */
const NOT_A_CHANNEL_RE = /^(?:process|req|request|res|response|stream|readable|writable|window|document|el|element|\$|server|app|child|proc|ws|wss|db|knex|vm|emit)$/;
/** AWS SDK v3 commands that put a message on a queue or topic, or take one off. */
const AWS_SEND_COMMANDS = new Map<string, { kind: "queue-publish" | "queue-consume"; key: string; name: string }>([
  ["SendMessageCommand", { kind: "queue-publish", key: "QueueUrl", name: "SQS: send" }],
  ["SendMessageBatchCommand", { kind: "queue-publish", key: "QueueUrl", name: "SQS: send" }],
  ["ReceiveMessageCommand", { kind: "queue-consume", key: "QueueUrl", name: "SQS: receive" }],
  ["PublishCommand", { kind: "queue-publish", key: "TopicArn", name: "SNS: publish" }],
  ["PublishBatchCommand", { kind: "queue-publish", key: "TopicArn", name: "SNS: publish" }],
]);
/** SDK v2 methods, the same operations. */
const AWS_V2_METHODS = new Map<string, { kind: "queue-publish" | "queue-consume"; key: string; name: string }>([
  ["sendMessage", { kind: "queue-publish", key: "QueueUrl", name: "SQS: send" }],
  ["sendMessageBatch", { kind: "queue-publish", key: "QueueUrl", name: "SQS: send" }],
  ["receiveMessage", { kind: "queue-consume", key: "QueueUrl", name: "SQS: receive" }],
]);
/**
 * A queue or topic named by its URL, ARN or the variable holding it: the URL's
 * last segment (`…/123/orders` → `orders`), the ARN's (`arn:…:orders-topic`),
 * an env var's name (`process.env.ORDERS_QUEUE_URL`), or an identifier.
 */
function queueTarget(node: Node | null): string | null {
  if (!node) return null;
  const lit = literalString(node);
  if (lit) return lit.split(/[/:]/).filter(Boolean).pop() ?? lit;
  const env = /^process\.env\.([A-Za-z_][\w]*)$|^process\.env\[['"]([^'"]+)['"]\]$/.exec(node.text);
  if (env) return env[1] ?? env[2]!;
  return node.type === "identifier" || node.type === "member_expression" ? node.text.split(".").pop()! : null;
}

function mqEvidence(src: string): MqEvidence {
  let bullQueues: Map<string, string> | null = null;
  if (BULL_IMPORT_RE.test(src)) {
    bullQueues = new Map();
    for (const m of src.matchAll(/(?:^|[\s,;({])(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:[?!]?:\s*[\w$.<>]+\s*)?=\s*(?:new\s+)?(?:Queue|Bull)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      bullQueues.set(m[1]!, m[2]!);
    }
    for (const m of src.matchAll(/@InjectQueue\(\s*['"`]([^'"`]+)['"`]\s*\)\s*(?:(?:private|protected|public|readonly)\s+)*([A-Za-z_$][\w$]*)/g)) {
      bullQueues.set(m[2]!, m[1]!);
    }
  }
  return {
    bullQueues,
    socketIo: SOCKET_IO_IMPORT_RE.test(src),
    nestEvents: /['"]@nestjs\/event-emitter['"]/.test(src),
    emitters: emitterReceivers(src),
    redis: /(?:from\s*|require\(\s*)['"](?:redis|ioredis|@redis\/client)['"]/.test(src),
  };
}

/** Method names that are chaining noise, not meaningful calls */
const NOISE_METHODS = new Set([
  "then", "catch", "finally", "json", "text", "blob", "arrayBuffer", "formData",
  "send", "status", "end", "log", "warn", "error", "info",
  "toString", "valueOf", "toJSON",
]);


export class JavaScriptDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  /**
   * URL-builder helper calls in api-call targets
   * (`axios.get(requestUri('teamtalk','v4'))` → `/api/v4/institution/{}/teamtalk`):
   * a call funneled through a project URL helper gets the concrete path the
   * cross-tier linker can join.
   */
  override resolveProject(calls: ProjectApiCall[], analyses: FileAnalysis[], ctx: ProjectContext): number {
    // Calls of Kubb-generated clients (kubb.ts) are added first: the module they name is not on disk.
    return resolveKubbClientCalls(calls, analyses, ctx) + resolveRtkHooks(calls, analyses, ctx) + resolveUrlBuilders(calls, analyses, ctx);
  }

  /**
   * File-local map of `const X = '…url…'` bindings so a `fetch(X)` /
   * `` fetch(`${X}?q=…`) `` can recover the endpoint URL. Real Vue/React data
   * layers hoist endpoints into module consts — frequently
   * `import.meta.env.VITE_X ?? '/site/cui_checkout_json'` — and call `fetch` with
   * the identifier, so without this the api-call carried no URL and never joined
   * to a backend route.
   *
   * Built LAZILY (a whole-tree walk) the first time a URL argument is actually a
   * bare identifier or template — the overwhelmingly common string-literal
   * `fetch('/x')` and the many files with no fetch at all never pay for it.
   * `null` = not yet built; reset after each `extract()` (the extractor is a
   * per-worker singleton run sequentially), so it never leaks across files.
   */
  private root: Node | null = null;
  private urlBindings: UrlBindings | null = null;
  /** File source, kept for the one-time gql-operation scan (see {@link scanGql}). */
  private sourceText = "";
  private gqlScanned = false;
  /** The file is an openapi-generator client (see generated-clients.ts). */
  private generatedClient = false;
  /** What the file's imports say about ORM use, read on first need (most files never ask). */
  private imports: ImportEvidence | null = null;
  /** What the file's imports say about job queues and Socket.IO, read on first need. */
  private mq: MqEvidence | null = null;
  /** The file names tRPC (its client import), so `x.y.useQuery()` chains are procedure calls. */
  private trpcClient: boolean | null = null;
  /** Names the file's Kysely queries give their common table expressions. */
  private kyselyCtes: Set<string> | null = null;
  /** RTK Query: whether the file defines an API slice, and the slice's `fetchBaseQuery` base. */
  private rtk: { slice: boolean; base: string } | null = null;
  /** RTK Query triggers a generated hook hands back (`const [remove] = useDeleteGameMutation()`), with the scope that declares them. */
  private rtkTriggers: Map<string, { hook: string; endpoint: string; start: number; end: number }> | null = null;

  /**
   * RTK Query. In an API slice (`createApi` / `injectEndpoints`), each
   * `build.query({ query: … })` / `build.mutation(…)` endpoint is an api-call
   * at the slice's base URL plus the path its `query` returns (a string, or
   * `{ url, method }`), tagged with the endpoint's name. Elsewhere, a generated
   * hook (`useGetPostsQuery`, `useLazyGetPostsQuery`, `useAddPostMutation`) or
   * `api.endpoints.getPosts.initiate()` is a call to that endpoint, whose
   * method and URL the project pass fills from the slice the hook is imported
   * from (`resolveRtkHooks`).
   */
  /** The object is what an RTK Query endpoint's `query` returns. */
  private inRtkQuery(node: Node): boolean {
    if (!(this.rtk ??= rtkEvidence(this.sourceText)).slice) return false;
    let n: Node | null = node.parent;
    for (let i = 0; n && i < 6; i++, n = n.parent) {
      if ((n.type === "pair" || n.type === "method_definition") && (n.childForFieldName("key") ?? n.childForFieldName("name"))?.text === "query") return true;
    }
    return false;
  }

  private rtkCall(node: Node, fn: Node | null, fnName: string, sources: DataSourceInfo[]): boolean {
    const line = node.startPosition.row + 1;
    if (fn?.type === "member_expression" && (fnName === "query" || fnName === "mutation" || fnName === "infiniteQuery")) {
      const rtk = (this.rtk ??= rtkEvidence(this.sourceText));
      const pair = node.parent?.type === "pair" ? node.parent : null;
      const endpoint = pair?.childForFieldName("key")?.text;
      if (!rtk.slice || !endpoint || fn.childForFieldName("object")?.type !== "identifier") return false;
      const def = node.childForFieldName("arguments")?.namedChildren[0];
      // `query: (id) => …`, or the method shorthand `query(id) { return … }`.
      const query = def?.type === "object"
        ? objectPropValue(def, "query") ?? def.namedChildren.find((m) => m.type === "method_definition" && m.childForFieldName("name")?.text === "query") ?? null
        : null;
      // What `query` returns — each `return` of a block body — as a path or a
      // `{ url, method }`; a URL held in a local (`let url = …; return url`,
      // `return { url, params }`) or a ternary gives every value it can take.
      const returned = query && /arrow_function|function|method_definition/.test(query.type) ? returnedValues(query) : [];
      const paths: string[] = [];
      let stated: string | null = null;
      for (const r of returned) {
        const spec = r.type === "object" ? r : null;
        const lit = literalString(spec ? objectPropValue(spec, "url") : r);
        const urls = lit !== null ? [lit] : spec ? this.descriptorUrls(spec, "url") : this.urlsOf(r);
        paths.push(...urls.filter((u) => !/^\$\{[^}]*\}$/.test(u)));
        stated ??= spec ? literalString(objectPropValue(spec, "method")) : null;
      }
      if (paths.length === 0) return false;
      const method = stated?.toUpperCase() ?? (fnName === "mutation" ? "POST" : "GET");
      const targets = [...new Set(paths.map((path) => rtk.base ? `${rtk.base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}` : path.startsWith("/") ? path : `/${path}`))];
      sources.push(this.ds({
        kind: "api-call", name: method, target: targets[0]!, line, endpoint: stripQuotes(endpoint),
        ...(targets.length > 1 ? { targetAlternatives: targets.slice(1) } : {}),
      }));
      return true;
    }
    // `useGetPostsQuery(…)` imported from a slice; `api.endpoints.getPosts.initiate(…)`.
    const hook = fn?.type === "identifier" ? /^use(?:Lazy)?([A-Z][\w$]*?)(?:Query|Mutation|InfiniteQuery|QueryState)$/.exec(fnName) : null;
    const initiate = fn?.type === "member_expression" && fnName === "initiate" ? /\.endpoints\.([\w$]+)\.initiate$/.exec(fn.text.replace(/\s+/g, "")) : null;
    if (hook && (this.imports ??= importEvidence(this.sourceText)).names.has(fnName)) {
      const endpoint = hook[1]![0]!.toLowerCase() + hook[1]!.slice(1);
      sources.push(this.ds({ kind: "api-call", name: fnName, target: null, line, endpoint }));
      // `const [remove] = useDeleteGameMutation()`: the mutation (or lazy query)
      // is sent where the trigger is called — in a click handler, not at render;
      // a query's `const { refetch: reload } = useGetGamesQuery()` sends it again.
      const decl = node.parent?.type === "variable_declarator" ? node.parent : null;
      const pattern = decl?.childForFieldName("name");
      const trigger = pattern?.type === "array_pattern"
        ? (/Mutation$|^useLazy/.test(fnName) ? pattern.namedChildren[0] : null)
        : pattern?.type === "object_pattern" ? refetchBinding(pattern) : null;
      if (trigger?.type === "identifier" || trigger?.type === "shorthand_property_identifier_pattern") {
        let scope: Node | null = decl!.parent;
        while (scope && !FUNCTION_SCOPES.has(scope.type)) scope = scope.parent;
        (this.rtkTriggers ??= new Map()).set(trigger.text, { hook: fnName, endpoint, start: scope?.startIndex ?? 0, end: scope?.endIndex ?? Infinity });
      }
      return true;
    }
    const trigger = fn?.type === "identifier" ? this.rtkTriggers?.get(fnName) : undefined;
    if (trigger && node.startIndex > trigger.start && node.startIndex < trigger.end) {
      sources.push(this.ds({ kind: "api-call", name: trigger.hook, target: null, line, endpoint: trigger.endpoint }));
      return true;
    }
    if (initiate) {
      sources.push(this.ds({ kind: "api-call", name: fn!.text.replace(/\s+/g, "").split(".")[0]!, target: null, line, endpoint: initiate[1]! }));
      return true;
    }
    return false;
  }

  override beginFile(tree: Tree, sourceText: string): void {
    this.root = tree.rootNode;
    this.urlBindings = null;
    this.generatedClient = sourceText.includes(GENERATED_CLIENT_MARKER);
    this.sourceText = sourceText;
    this.gqlScanned = false;
    this.imports = null;
    this.mq = null;
    this.trpcClient = null;
    this.kyselyCtes = null;
    this.rtk = null;
    this.rtkTriggers = null;
    this.collectionReceivers = null;
    this.routerReceivers = null;
    this.clientKinds = null;
    this.optionsApi = /\b(?:props|data)\s*[:(]/.test(sourceText);
  }

  /** The file may declare an Options-API component (`props:` / `data()`): gates the object check in `visitNode`. */
  private optionsApi = false;

  /**
   * A generic verb (`create`, `update`, `remove`, `findAll`) is a database
   * operation only with evidence for one: the file imports an ORM or driver, or
   * the receiver chain is repository/model-shaped (`this.userRepository.save`,
   * `ctx.prisma.user.create`), or its root is a model the file imports from a
   * `models/` path or declares. Without it `wrapper.findAll` (vue-test-utils),
   * `ContactAPI.create` (an API client) and `view.destroy` were database rows.
   */
  private hasOrmEvidence(chain: string): boolean {
    const imports = (this.imports ??= importEvidence(this.sourceText));
    if (imports.orm) return true;
    const parts = chain.split(".").map((p) => p.trim());
    if (chainHasOrmEvidence(parts)) return true;
    const root = parts[0]!.replace(/^this$/, parts[1] ?? "");
    if (imports.models.has(root)) return true;
    // A PascalCase root the file does not import is a model in scope (a global, an
    // injected model, a test snippet); one imported from elsewhere (`ContactAPI`
    // from '../api/contacts') or named like a client is not.
    if (isModelLikeRoot(root) && !/(?:API|Api|Service|Client|Store|Helper|Utils?|Wrapper|View)$/.test(root)) {
      return !imports.names.has(root);
    }
    return false;
  }

  override endFile(): void {
    this.root = null;
    this.urlBindings = null;
    this.sourceText = "";
  }

  /**
   * Emit api-calls for the file's `gql`…`` / `graphql`…`` operation templates,
   * ONCE per file (there is no whole-file hook in the fused walk, so it piggy-
   * backs on the first node visit). Gated on the gql tag so gql-free files —
   * the overwhelming majority — pay only a substring check.
   */
  private scanGql(sources: DataSourceInfo[]): void {
    this.gqlScanned = true;
    const src = this.sourceText;
    if (!src.includes("gql`") && !src.includes("graphql`")) return;
    sources.push(...extractGqlOperationCalls(src));
  }

  /** Lazily build + cache the file's URL bindings (see {@link urlBindings}). */
  private bindings(): UrlBindings | null {
    if (this.urlBindings === null && this.root) this.urlBindings = new UrlBindings(this.root);
    return this.urlBindings;
  }

  /**
   * Resolve a `fetch`/client call's URL argument to an app-relative path. A
   * string literal resolves directly; a bare identifier is resolved through the
   * file-local const map (now multi-hop and concat-aware via the symbolic value
   * resolver); a template's `${id}` interpolation is substituted from the same
   * map, reproducing an unresolved interpolation verbatim so an otherwise
   * unchanged template yields the same target as before. A leading environment
   * or runtime base is stripped to keep the path joinable (its env var, when
   * known, is returned in `baseEnv`).
   */
  private resolveUrlArg(arg: Node): ResolvedUrl | null {
    if (arg.type === "string") return { url: stripQuotes(arg.text), confidence: "EXTRACTED" };
    if (arg.type === "parenthesized_expression" && arg.namedChild(0)) return this.resolveUrlArg(arg.namedChild(0)!);
    // `fetch(new URL('predict', base))`: the path, under the base when it is relative.
    if (arg.type === "new_expression" && arg.childForFieldName("constructor")?.text === "URL") {
      const [pathArg, baseArg] = arg.childForFieldName("arguments")?.namedChildren ?? [];
      const path = pathArg ? this.resolveUrlArg(pathArg) : null;
      if (!path) return null;
      if (!baseArg || /^(?:\/|[a-z][\w+.-]*:)/i.test(path.url)) return path;
      const base = baseArg.type === "identifier" || baseArg.type === "member_expression" ? `\${${baseArg.text}}` : null;
      return base ? { url: `${base}/${path.url.replace(/^\.\//, "")}`, confidence: "INFERRED" } : path;
    }
    // `fetch(qs ? `${path}?${qs}` : path)`: each arm; arms that differ only by a query string are one path.
    if (arg.type === "ternary_expression") {
      const both = [arg.childForFieldName("consequence"), arg.childForFieldName("alternative")];
      // `` `${path}?${qs}` `` beside `path` itself: the path, its query optional.
      const bare = both.find((a) => a?.type === "identifier");
      const queried = both.find((a) => a?.type === "template_string" && bare && a.text.startsWith(`\`\${${bare.text}}?`));
      if (bare && queried) return this.resolveUrlArg(bare);
      const arms = both
        .map((a) => (a ? this.resolveUrlArg(a) : null))
        .filter((r): r is ResolvedUrl => r !== null);
      if (arms.length === 0) return null;
      const urls = [...new Set(arms.flatMap((r) => [r.url, ...(r.alternatives ?? [])]))];
      const paths = [...new Set(urls.map((u) => u.split("?")[0]!))];
      if (paths.length === 1) return { ...(arms.find((r) => !r.url.includes("?")) ?? arms[0]!), confidence: "INFERRED" };
      return { url: urls[0]!, alternatives: urls.slice(1), confidence: "INFERRED" };
    }
    // `fetch(url.toString())`, `fetch(url.href)`, `fetch(url)` with `const url = new URL(path, origin)`:
    // the request is the URL's path argument — a parameter of a request factory
    // stays a `${path}` hole for the factory expansion to fill per call site.
    const built = urlObjectPath(arg);
    if (built) {
      if (built.type === "identifier" && declaredParamInScope(built.text, arg)) return { url: `\${${built.text}}`, confidence: "INFERRED" };
      return this.resolveUrlArg(built);
    }
    if (arg.type === "template_string") {
      // `` `${API}${endpoint}` `` with `endpoint` one of several paths: one URL per value.
      const multi = arg.namedChildren
        .map((p) => (p.type === "template_substitution" && p.namedChild(0)?.type === "identifier" ? p.namedChild(0)!.text : null))
        .filter((n): n is string => n !== null)
        .map((n) => ({ n, values: this.localUrls(n, arg) }))
        .filter((m) => m.values !== null);
      if (multi.length === 1) {
        const { n, values } = multi[0]!;
        const urls = [...new Set(values!.map((v) => resolveTemplateUrl(arg, (name) => (name === n ? { url: v, confidence: "INFERRED" } : this.lookupUrl(name, arg)))))];
        return { url: urls[0]!, ...(urls.length > 1 ? { alternatives: urls.slice(1) } : {}), confidence: "INFERRED" };
      }
      const url = resolveTemplateUrl(arg, (name) => this.lookupUrl(name, arg));
      // A leftover `${…}` means the template couldn't be fully resolved.
      return { url, confidence: url.includes("${") ? "INFERRED" : "EXTRACTED" };
    }
    if (arg.type === "identifier") {
      const values = this.localUrls(arg.text, arg);
      if (values) return { url: values[0]!, alternatives: values.slice(1), confidence: "INFERRED" };
      const found = this.lookupUrl(arg.text, arg);
      if (found) return found;
      // `const url = requestUri('x', 'v3'); axios.get(url)`: the builder call,
      // as it would be read inline.
      const value = this.bindings()?.valueOf(arg.text, arg);
      if (value?.type === "call_expression") return this.resolveUrlArg(value);
      // `const send = (url, options) => fetch(url, options)`: a request wrapper's
      // parameter stays a `${url}` hole, which the request-factory pass fills
      // from each call site (`send(`${API}/clubs`, …)`).
      return value == null && declaredParamInScope(arg.text, arg) ? { url: `\${${arg.text}}`, confidence: "INFERRED" } : null;
    }
    // `this.baseUrl + 'series/' + seriesId` — Angular's dominant spelling
    // (Kavita: 398 of 417 call sites). Rendered the way a template literal is,
    // `${this.baseUrl}series/${seriesId}`, so one downstream path handles both.
    if (arg.type === "binary_expression" && arg.childForFieldName("operator")?.text === "+") {
      const url = this.concatUrl(arg);
      return url === null ? null : { url, confidence: url.includes("${") ? "INFERRED" : "EXTRACTED" };
    }
    // `this.url`, `routes.tags`: a URL held in a field or a route table. Kept as
    // a hole a project pass may still fill; only a trusted client call emits it.
    if (arg.type === "member_expression") return { url: `\${${arg.text}}`, confidence: "INFERRED" };
    // A URL-builder helper call: `axios.get(requestUri('teamtalk', 'v4'))`.
    // Keep the call text verbatim (whitespace-collapsed) so a project-level pass
    // can substitute the helper's template and recover the concrete URL. Emitted
    // only on a trusted HTTP receiver (see visitNode) so a non-client verb call
    // isn't mistaken for one.
    if (arg.type === "call_expression") {
      // A bare-identifier argument bound to a literal path in scope (`apiPath(club,
      // SQUAD_ENDPOINT)`) is spelled as that literal, which the helper pass substitutes.
      let text = arg.text;
      const args = arg.childForFieldName("arguments")?.namedChildren ?? [];
      for (const a of [...args].reverse()) {
        if (a.type !== "identifier") continue;
        const bound = this.bindings()?.lookup(a.text, a);
        if (!bound || bound.confidence !== "EXTRACTED" || bound.url.includes("${") || /['"`\\]/.test(bound.url)) continue;
        const at = a.startIndex - arg.startIndex;
        text = `${text.slice(0, at)}'${bound.url}'${text.slice(at + a.text.length)}`;
      }
      return { url: text.replace(/\s+/g, " ").trim(), confidence: "INFERRED" };
    }
    return null;
  }

  /**
   * The URL a local holds, as the URL bindings fold it — except one built on a
   * field (`const url = `${this.url}/search?${…}``), read as the template
   * itself, so the class's base stays a hole the project pass fills (the fold
   * has no `this` and would drop it), also where the local is interpolated
   * into another URL (`` fetch(`${url}?${params}`) ``).
   */
  private lookupUrl(name: string, at: Node): ResolvedUrl | null {
    const init = this.bindings()?.valueOf(name, at);
    if ((init?.type === "template_string" || init?.type === "binary_expression") && init.text.includes("this.") && this.inlineDepth < 4) {
      this.inlineDepth++;
      try {
        const inline = this.resolveUrlArg(init);
        if (inline) return inline;
      } finally {
        this.inlineDepth--;
      }
    }
    return this.bindings()?.lookup(name, at) ?? null;
  }

  /** How many locals {@link lookupUrl} is reading through (a local built on itself stops). */
  private inlineDepth = 0;

  /**
   * The values a local URL takes when it can take several: both arms of a
   * ternary initializer (`const url = all ? `${API}/teams/all` : `${API}/teams``),
   * its initializer and each plain assignment the enclosing function makes
   * before `at` (`let url; if (id) url = A; else url = B;`), or each element of
   * the array a loop walks (`for (const url of [A, B])`). Null for one value
   * (unless a loop states it), or when the local is also built up (`url += …`),
   * which the fold reads.
   */
  private localUrls(name: string, at: Node): string[] | null {
    let fn: Node | null = at.parent;
    while (fn && !FUNCTION_SCOPES.has(fn.type)) fn = fn.parent;
    if (!fn) return null;
    // `action: "preview" | "apply"`: a parameter typed as the strings it can be.
    const typedParam = (from: Node): string[] | null => {
      for (let p: Node | null = from; p; p = p.parent) {
        if (!FUNCTION_SCOPES.has(p.type) || !declaresParam(p, name)) continue;
        const values = literalUnionParam(p, name);
        return values && values.length > 1 ? values : null;
      }
      return null;
    };
    if (declaresParam(fn, name)) return typedParam(fn);
    // Set inside the walk, which the compiler's narrowing does not see.
    let init = null as Node | null;
    let declared = false as boolean;
    const assigned: Node[] = [];
    let augmented = false as boolean;
    let looped = false as boolean;
    const walk = (n: Node): void => {
      for (const c of n.namedChildren) {
        if (c.startIndex >= at.startIndex) return;
        if (FUNCTION_SCOPES.has(c.type)) continue;
        if (c.type === "variable_declarator" && c.childForFieldName("name")?.text === name) {
          declared = true;
          init = c.childForFieldName("value");
        } else if (c.type === "for_in_statement" && c.childForFieldName("left")?.text === name && c.endIndex > at.startIndex) {
          // `for (const url of [a, b])`, or of a local array of URLs (either arm of a ternary): each element.
          let list: Node | null = c.childForFieldName("right");
          if (list?.type === "identifier") list = this.bindings()?.valueOf(list.text, list) ?? null;
          const arrays = list?.type === "ternary_expression"
            ? [list.childForFieldName("consequence"), list.childForFieldName("alternative")]
            : [list];
          if (arrays.every((x) => x?.type === "array")) {
            declared = true;
            looped = true;
            init = null;
            for (const x of arrays) assigned.push(...x!.namedChildren);
          }
        } else if (c.type === "assignment_expression" && c.childForFieldName("left")?.text === name) {
          const right = c.childForFieldName("right");
          if (right) assigned.push(right);
        } else if (c.type === "augmented_assignment_expression" && c.childForFieldName("left")?.text === name) {
          augmented = true;
        }
        walk(c);
      }
    };
    walk(fn);
    if (!declared) return fn.parent ? typedParam(fn.parent) : null;
    if (augmented) return null;
    let value: Node | null = init;
    while (value && (value.type === "parenthesized_expression" || value.type === "as_expression")) value = value.namedChild(0);
    const sources = assigned.length > 0 ? [...(value ? [value] : []), ...assigned] : value?.type === "ternary_expression" ? [value] : [];
    // A placeholder initializer (`let url = ""`) is no request.
    const urls = [...new Set(sources.flatMap((v) => this.urlsOf(v)))].filter((u) => u.trim() !== "" && !/^\$\{[^}]*\}$/.test(u));
    return urls.length > 1 || (looped && urls.length === 1) ? urls : null;
  }

  /**
   * A `+` chain as a URL: string and template pieces as written (a template's
   * `${id}` substituted from the URL bindings in scope, as a whole-template
   * argument is), an identifier bound to a URL in scope by its value, and
   * anything else — a field, a call, a parameter — as a `${…}` hole. Null when
   * no piece is a string at all (`a + b` is arithmetic, not a URL).
   */
  private concatUrl(expr: Node): string | null {
    const pieces: Node[] = [];
    const flatten = (n: Node): void => {
      if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
        flatten(n.childForFieldName("left")!);
        flatten(n.childForFieldName("right")!);
      } else if (n.type === "parenthesized_expression" && n.namedChild(0)) {
        flatten(n.namedChild(0)!);
      } else pieces.push(n);
    };
    flatten(expr);
    if (!pieces.some((p) => p.type === "string" || p.type === "template_string")) return null;
    let out = "";
    for (const p of pieces) {
      if (p.type === "string") out += stripQuotes(p.text);
      else if (p.type === "template_string") out += resolveTemplateUrl(p, (name) => this.lookupUrl(name, p));
      else if (p.type === "identifier") out += this.lookupUrl(p.text, p)?.url ?? `\${${p.text}}`;
      else out += `\${${p.text.replace(/\s+/g, " ")}}`;
    }
    return out;
  }

  /**
   * The URL(s) a request descriptor's key holds: a literal, a template or `+`
   * chain with its holes, an identifier bound to a URL in scope (else a
   * `${name}` hole — a request factory's parameter, filled in at each call
   * site by a project pass), both arms of a ternary
   * (`url: id == null ? url : `${url}/${id}``). Empty when it is none of these.
   */
  private descriptorUrls(obj: Node, key: string): string[] {
    const value = objectPropValue(obj, key);
    if (value) return [...new Set(this.urlsOf(value))];
    const shorthand = obj.namedChildren.find((c) => c.type === "shorthand_property_identifier" && c.text === key);
    if (!shorthand) return [];
    return [this.lookupUrl(key, shorthand)?.url ?? "${" + key + "}"];
  }

  private urlsOf(v: Node): string[] {
    let n: Node | null = v;
    while (n && (n.type === "parenthesized_expression" || n.type === "as_expression" || n.type === "non_null_expression")) {
      n = n.namedChild(0);
    }
    if (!n) return [];
    if (n.type === "ternary_expression") {
      return [...this.urlsOf(n.childForFieldName("consequence")!), ...this.urlsOf(n.childForFieldName("alternative")!)];
    }
    if (n.type === "template_string") return [resolveTemplateUrl(n, (name) => this.lookupUrl(name, n!))];
    if (n.type === "identifier") return [this.lookupUrl(n.text, n)?.url ?? `\${${n.text}}`];
    if (n.type === "binary_expression") {
      const url = this.concatUrl(n);
      return url ? [url] : [];
    }
    const lit = literalString(n);
    return lit === null ? [] : [lit];
  }

  /** Receivers this file builds from an SDK client class, by what that client talks to. */
  private clientKinds: Map<string, "sdk" | "vector"> | null = null;

  /**
   * What the client a chain starts on talks to, when the file builds it from a
   * known SDK (`const client = new OpenAI()`, `new Client(…)` from the MCP
   * SDK, `new QdrantClient(…)`, `axios.create(…)`): an API, or a vector store. Null for anything
   * else, including every database client.
   */
  private clientKind(chain: string): "sdk" | "vector" | null {
    if (!this.clientKinds) {
      this.clientKinds = new Map();
      const from = new Map<string, string>();
      for (const m of this.sourceText.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g)) {
        if (m[1]) from.set(m[1], m[3]!);
        for (const part of (m[2] ?? "").split(",")) {
          const local = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (local) from.set(local, m[3]!);
        }
      }
      const kindOfClass = (cls: string): "sdk" | "vector" | null => {
        const pkg = from.get(cls) ?? "";
        return VECTOR_SDK_RE.test(pkg) || VECTOR_CLIENT_CLASS_RE.test(cls) ? "vector" : API_SDK_RE.test(pkg) ? "sdk" : null;
      };
      // `x = new QdrantClient(…)`, `x: QdrantClient`, and a local factory's
      // product: `function getClient(): QdrantClient` … `const q = getClient()`.
      for (const m of this.sourceText.matchAll(/(?:^|[\s,;({])(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:[?!]?:\s*[\w$.<>]+\s*)?=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        const kind = kindOfClass(m[2]!);
        if (kind) this.clientKinds.set(m[1]!, kind);
      }
      for (const m of this.sourceText.matchAll(/(?:^|[\s,;({])(?:this\.)?([A-Za-z_$][\w$]*)\s*[?!]?:\s*([A-Za-z_$][\w$]*)\b/g)) {
        const kind = kindOfClass(m[2]!);
        if (kind) this.clientKinds.set(m[1]!, kind);
      }
      // An HTTP client instance (`const client = axios.create({ baseURL })`) talks to an API, never a database.
      for (const m of this.sourceText.matchAll(/(?:^|[\s,;({])(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:[?!]?:\s*[\w$.<>]+\s*)?=\s*(?:axios|ky|got|wretch|ofetch)\.(?:create|extend)\s*\(/g)) {
        this.clientKinds.set(m[1]!, "sdk");
      }
      const factories = new Map<string, "sdk" | "vector">();
      for (const m of this.sourceText.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*(?:Promise\s*<\s*)?([A-Za-z_$][\w$]*)/g)) {
        const kind = kindOfClass(m[2]!);
        if (kind) factories.set(m[1]!, kind);
      }
      if (factories.size > 0) {
        for (const m of this.sourceText.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
          const kind = factories.get(m[2]!);
          if (kind) this.clientKinds.set(m[1]!, kind);
        }
      }
    }
    const parts = chain.split(".").map((p) => p.trim());
    const root = parts[0] === "this" ? parts[1] ?? "" : parts[0]!;
    return this.clientKinds.get(root) ?? null;
  }

  /** Receivers this file declares as a collection: `const cache = new Map()`, `private seen: Set<string>`. */
  private collectionReceivers: Set<string> | null = null;

  private isCollectionReceiver(name: string): boolean {
    if (NON_HTTP_RECEIVERS.has(name)) return true;
    if (!this.collectionReceivers) {
      this.collectionReceivers = new Set();
      const kinds = "(?:Map|Set|WeakMap|WeakSet|URLSearchParams|Headers|FormData)";
      const re = new RegExp(String.raw`(?:^|[\s,;({])(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:[?!]?:\s*(?:Readonly)?${kinds}\b[^=;\n]*)?=\s*new\s+${kinds}\b|(?:^|[\s,;({])([A-Za-z_$][\w$]*)\s*[?!]?:\s*(?:Readonly)?${kinds}\s*<`, "g");
      for (const m of this.sourceText.matchAll(re)) this.collectionReceivers.add((m[1] ?? m[2])!);
    }
    return this.collectionReceivers.has(name);
  }

  /** Receivers this file makes a server router or app: `const reports = Router()`, `const app = new Hono()`. */
  private routerReceivers: Set<string> | null = null;

  private serverRouterReceivers(): Set<string> {
    if (!this.routerReceivers) {
      this.routerReceivers = new Set();
      if (/Router|express|Hono|Koa|fastify|Elysia/.test(this.sourceText)) {
        for (const m of this.sourceText.matchAll(SERVER_ROUTER_INIT_RE)) this.routerReceivers.add(m[1]!);
      }
    }
    return this.routerReceivers;
  }

  /** Whether an object literal is an argument of a call to an HTTP client (`http.request({…})`, `axios({…})`). */
  private passedToHttpClient(obj: Node): boolean {
    if (obj.parent?.type !== "arguments") return false;
    const fn = obj.parent.parent?.childForFieldName("function") ?? null;
    if (!fn) return false;
    const leaf = calleeLeaf(fn);
    if (!leaf) return false;
    if (fn.type === "identifier") return isHttpRoot(leaf); // `request`, `http`, an imported `httpRequest` alias
    if (fn.type !== "member_expression") return false;
    const recv = directReceiver(fn) ?? memberRoot(fn);
    const clientRecv = !!recv && (HTTP_RECEIVER_RE.test(recv) || /client$/i.test(recv) || /^https?$/i.test(recv));
    return clientRecv && (HTTP_ROOTS.has(leaf.toLowerCase()) || HTTP_VERBS.has(leaf.toLowerCase()));
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // One-time gql-operation scan (no whole-file hook exists in the fused walk).
    if (!this.gqlScanned) this.scanGql(sources);

    // Vue Options API: `export default { props: {…}, data() { return {…} } }` /
    // `defineComponent({…})` declares what `<script setup>` declares with
    // `defineProps` and `ref`: one prop row per prop, one state row per data key.
    if (node.type === "object" && this.optionsApi && isOptionsComponent(node)) {
      for (const pair of node.namedChildren) {
        const key = optionKey(pair);
        if (key === "props") {
          const value = pair.type === "pair" ? pair.childForFieldName("value") : null;
          for (const name of propNamesOf(value)) sources.push(this.ds({ kind: "prop", name, target: null, line: pair.startPosition.row + 1 }));
        } else if (key === "data") {
          for (const name of dataKeysOf(pair)) sources.push(this.ds({ kind: "state", name: "data", target: name, line: pair.startPosition.row + 1 }));
        }
      }
    }

    // Vuex `...mapGetters('league', ['standings'])` / `...mapState({ club: 'club' })`:
    // the store reads a component binds, one row per key it names.
    if (node.type === "call_expression") {
      const helper = node.childForFieldName("function")?.text;
      if (helper === "mapGetters" || helper === "mapState") {
        for (const target of mappedStoreKeys(node)) sources.push(this.ds({ kind: "store", name: helper, target, line: node.startPosition.row + 1 }));
        return;
      }
    }

    // BullMQ: `new Worker("emails", processor)` consumes the queue it names.
    if (node.type === "new_expression" && node.childForFieldName("constructor")?.text === "Worker") {
      const mq = (this.mq ??= mqEvidence(this.sourceText));
      const queue = mq.bullQueues ? literalString(node.childForFieldName("arguments")?.namedChildren[0] ?? null) : null;
      if (queue) sources.push(this.ds({ kind: "queue-consume", name: "BullMQ: Worker", target: queue, line: node.startPosition.row + 1 }));
      return;
    }
    // NestJS: `@Processor("audio") class AudioConsumer { process(job) }` consumes the queue; the row sits on `process`.
    if (node.type === "call_expression" && node.parent?.type === "decorator" && node.childForFieldName("function")?.text === "Processor") {
      const queue = (this.mq ??= mqEvidence(this.sourceText)).bullQueues ? literalString(node.childForFieldName("arguments")?.namedChildren[0] ?? null) : null;
      if (queue) {
        const holder = node.parent.parent;
        const cls = holder?.type === "export_statement" ? holder.childForFieldName("declaration") : holder;
        const body = cls?.childForFieldName("body");
        const process = body?.namedChildren.find((m) => m.type === "method_definition" && m.childForFieldName("name")?.text === "process");
        sources.push(this.ds({ kind: "queue-consume", name: "BullMQ: Processor", target: queue, line: (process ?? node).startPosition.row + 1 }));
      }
      return;
    }

    // NestJS events: `@OnEvent("order.created") handle(…)` consumes the event; the row sits on the method.
    if (node.type === "call_expression" && node.parent?.type === "decorator" && node.childForFieldName("function")?.text === "OnEvent") {
      const event = (this.mq ??= mqEvidence(this.sourceText)).nestEvents ? literalString(node.childForFieldName("arguments")?.namedChildren[0] ?? null) : null;
      if (event) {
        let method = node.parent.nextNamedSibling;
        while (method?.type === "decorator") method = method.nextNamedSibling;
        sources.push(this.ds({ kind: "queue-consume", name: "NestJS: OnEvent", target: event, line: (method ?? node).startPosition.row + 1 }));
      }
      return;
    }
    // AWS SDK v3: `new SendMessageCommand({ QueueUrl, … })`, `new PublishCommand({ TopicArn })`, `new ReceiveMessageCommand(…)`.
    if (node.type === "new_expression") {
      const op = AWS_SEND_COMMANDS.get(node.childForFieldName("constructor")?.text ?? "");
      const desc = node.childForFieldName("arguments")?.namedChildren[0];
      if (op && desc?.type === "object") {
        const target = queueTarget(objectPropValue(desc, op.key));
        if (target) sources.push(this.ds({ kind: op.kind, name: op.name, target, line: node.startPosition.row + 1 }));
        return;
      }
    }

    if (node.type === "call_expression") {
      let fn = node.childForFieldName("function");
      // `await foo<T>(args)` mis-nests as call(function: await_expression(await,
      // foo), type_arguments, arguments) — the generic forces the await to bind
      // to `foo` alone. Unwrap so the callee resolves to `foo`, not the await.
      if (fn && fn.type === "await_expression") {
        fn = fn.namedChild(fn.namedChildCount - 1) ?? fn;
      }
      // Leaf/callee name drives detection. For `apiClient.post(...)` the leaf is
      // `post`, not the object — using the full member-chain text would let any
      // substring (`Sec-Fetch-User`, `events/fetchEventTypes`) spuriously match.
      // Keep the dotted chain only for the ORM root check (`prisma.user.findMany`).
      const fnName = calleeLeaf(fn);
      const ormChain = fn && fn.type === "member_expression" ? fn.text : fnName;
      // A call emitted as an HTTP api-call below must not ALSO be emitted as a
      // database op: `apiClient.get("/owners")` is HTTP, but its leaf `get`
      // collides with Drizzle's `.get()` in ORM_METHODS.
      let emittedApiCall = false;

      // RTK Query: an endpoint definition in an API slice, or a component's generated hook.
      if (fnName && this.rtkCall(node, fn, fnName, sources)) return;

      // tRPC client: `trpc.post.byId.useQuery(…)`, `api.post.create.useMutation()`,
      // `utils.post.byId.fetch()` request the procedure's path (see routes/trpc.ts).
      if (fnName && fn?.type === "member_expression" && TRPC_CLIENT_VERBS.has(fnName) && (this.trpcClient ??= /trpc/i.test(this.sourceText))) {
        const chain = fn.text.replace(/\s+/g, "");
        const parts = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}$/.test(chain) ? chain.split(".") : [];
        const path = parts.slice(1, -1).filter((p, i) => !(i === 0 && p === "client"));
        if (parts.length && parts[0] !== "this" && path.length) {
          sources.push(this.ds({ kind: "api-call", name: TRPC_CLIENT_VERBS.get(fnName)!, target: `/trpc/${path.join(".")}`, line: node.startPosition.row + 1 }));
          return;
        }
      }

      if (fnName) {
        // HTTP call: fetch("/api/x"), axios.get("/api/x"), apiClient.post("/x").
        // Object-config calls (axios({url}), Kubb request({url})) are captured by
        // the request-descriptor `object` branch below.
        const isRoot = isHttpRoot(fnName);
        // jQuery's Ajax shorthands on the global itself — `$.get(url, data, cb)`,
        // `$.post(…)`, `jQuery.getJSON(…)` — are requests whatever follows the
        // URL; the trailing callback is the success handler, not a route handler.
        // `$('#x').get(0)` is a selection's DOM getter: its receiver is a call.
        const jqueryVerb = jqueryShorthandVerb(fn, fnName);
        const isVerb = HTTP_VERBS.has(fnName.toLowerCase()) || !!jqueryVerb;
        // A verb call on a known HTTP-client receiver (`axios.get`,
        // `apiClient.post`, `this.http.delete`) is itself a strong HTTP signal —
        // trust it like a named root so the URL-shape check is relaxed and a
        // helper-built URL (`axios.get(requestUri(...))`, no literal slash) is
        // still captured. Only the receiver the verb is called ON counts, and
        // only a client-shaped name: trusting the root of any chain read
        // `request.params.get('page')` in a test predicate as a GET to "page".
        const recvRoot = fn && fn.type === "member_expression" ? memberRoot(fn) : null;
        const recv = fn && fn.type === "member_expression" ? directReceiver(fn) : null;
        const trustedReceiver = !!jqueryVerb || (!!recv && (HTTP_RECEIVER_RE.test(recv) || /client$/i.test(recv)));
        // `app.get("/x", handler)` / `router.post(...)` are inbound route
        // definitions (already captured as routes), not outbound calls — exclude.
        // So is a route decorator: NestJS `@Get('public/:id')` is a call too.
        if ((isRoot || isVerb) && fn && (!!jqueryVerb || !isServerRouteDef(fn, node, this.serverRouterReceivers())) && node.parent?.type !== "decorator") {
          const args = node.childForFieldName("arguments");
          let firstArg = args && args.childCount > 1 ? args.child(1) : null;
          // Bare HTTP verbs (`get`/`post`/...) collide with `Map.get`,
          // `searchParams.get`, etc., so require a URL-shaped argument; named
          // clients (fetch/axios/http/request) and trusted client receivers are
          // trusted without it. A name that merely CONTAINS fetch/http
          // (`createFetchHandler('system.status', '/system/status')`) is a
          // project function that may take anything first — it needs the
          // URL-shaped argument too.
          // A client name as a METHOD counts only on a receiver that is itself
          // a client or a global (`$.ajax`, `window.fetch`, `api.request`):
          // `navigator.wakeLock.request("screen")` is not an HTTP call.
          // A BARE `request(…)` / `http(…)` / `ajax(…)` is the library only when
          // the file imports it, or the call has the shape of one
          // (`request('POST', url)` — a project's own XHR wrapper): VueUse's
          // `const { request } = useWakeLock()` makes `request("screen")` a
          // wake lock, not an HTTP call. `fetch` is a global and `axios` is
          // never anything else.
          const firstLiteral = node.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment");
          const verbFirst = firstLiteral?.type === "string" && HTTP_VERBS.has(stripQuotes(firstLiteral.text).toLowerCase());
          const bareLibrary = fn.type === "identifier" &&
            (/^(?:fetch|axios)$/i.test(fnName) || verbFirst || (this.imports ??= importEvidence(this.sourceText)).names.has(fnName));
          const exactRoot =
            HTTP_ROOTS.has(fnName.toLowerCase()) &&
            (bareLibrary || trustedReceiver || (!!recv && GLOBAL_RECEIVERS.has(recv)));
          const trusted = exactRoot || trustedReceiver;
          // `http.request('POST', url)` / `this.http.request('GET', url)`:
          // the verb comes first and the URL second.
          let callName = jqueryVerb ?? fnName;
          const positional = args?.namedChildren.filter((a) => a.type !== "comment") ?? [];
          if (trusted && fnName.toLowerCase() === "request" && positional.length > 1) {
            const verb = literalString(positional[0]!);
            if (verb && HTTP_VERBS.has(verb.toLowerCase())) {
              callName = verb.toLowerCase();
              firstArg = positional[1]!;
            }
          }
          // `fetch(url, { method: "POST" })`, `oazapfts.fetchJson(url, oazapfts.json({ ...opts, method: "POST" }))`:
          // a client named for fetching carries its verb in the options.
          if (!HTTP_VERBS.has(callName.toLowerCase())) {
            const verb = optionsMethod(positional[1]);
            if (verb) callName = verb;
            // The Fetch standard's default: `fetch(url)`, or an init literal that names no method
            // (and spreads nothing that could), is a GET.
            else if (/^fetch$/i.test(fnName) && fn.type === "identifier" && (positional.length === 1 || statesNoMethod(positional[1]))) callName = "get";
            // A generated oazapfts SDK states every other verb (`oazapfts.json({ ...opts, method: "PUT" })`):
            // its `fetchJson(url, { ...opts })` / `fetchBlob` / `fetchText` with none is a GET.
            else if (recv === "oazapfts" && /^fetch(?:Json|Blob|Text)$/.test(fnName)) callName = "get";
          }
          // openapi-generator's wrappers end `.then((request) => request(this.axios, this.basePath))`:
          // the first argument is the HTTP client itself, not a URL — the request
          // was already read where its creator builds `localVarPath`.
          // supertest's `request(app).get('/clubs')`: `request` wraps the app; the chained verb is the request.
          const supertest = fn.type === "identifier" && fnName === "request" && node.parent?.type === "member_expression" &&
            HTTP_VERBS.has(node.parent.childForFieldName("property")?.text.toLowerCase() ?? "");
          if (supertest) return;
          const clientArg = !!firstArg && /^(?:this\.)?(?:axios\w*|http(?:Client)?|client|instance)$/i.test(firstArg.text);
          const resolved = firstArg && !clientArg ? this.resolveUrlArg(firstArg) : null;
          // `fetch("data:image/svg+xml;base64,…")`, `fetch(blobUrl)` of a `blob:` literal: no request leaves the page.
          if (resolved && /^(?:data|blob):/i.test(resolved.url)) return;
          // A call-expression URL arg (a helper-built URL with no literal slash)
          // needs a STRICT HTTP signal — an exact client root (`fetch`/`axios`/…)
          // or a client member receiver (`axios.get`) — so a local data-fetcher
          // named `fetchX(localArg)` (matched by the fuzzy isHttpRoot) isn't read
          // as an HTTP call to a non-URL argument.
          const argIsCall = firstArg?.type === "call_expression";
          const strictHttp = exactRoot || trustedReceiver;
          // An untrusted verb call (`cache.get(k)`, `cy.get(sel)`, a local
          // `put(…)` helper) has only its argument to go on, so the argument
          // must be a request path — not merely contain a slash — and the
          // receiver must not be a collection the file builds itself.
          const urlEvidence = trusted
            ? !!resolved && looksLikeUrl(resolved.url)
            : !!resolved && urlShaped(resolved.url) && !(recv && this.isCollectionReceiver(recv));
          // A jQuery shorthand is trusted for a URL held in a variable or built
          // by a helper, but a literal must still read as one: `$.get('x')` is not.
          const literalNonUrl = !!jqueryVerb && firstArg?.type === "string" && !urlEvidence;
          if (
            resolved != null &&
            !literalNonUrl &&
            (urlEvidence || (trusted && (!argIsCall || strictHttp)))
          ) {
            sources.push(this.ds({
              kind: "api-call",
              name: callName,
              target: resolved.url,
              ...(resolved.alternatives?.length ? { targetAlternatives: resolved.alternatives } : {}),
              line: node.startPosition.row + 1,
              // Recovered env base (display only; `target` stays app-relative).
              ...(resolved.baseEnv ? { baseEnv: resolved.baseEnv } : {}),
              // The client instance (`apiClient.get(...)`): its base URL is
              // prepended by a project pass. Library roots (`axios`, `fetch`)
              // are not instances.
              ...(recvRoot && /^[A-Za-z_$][\w$]*$/.test(recvRoot) && !HTTP_ROOTS.has(recvRoot.toLowerCase()) && !GLOBAL_RECEIVERS.has(recvRoot)
                ? { client: recvRoot }
                : {}),
              // Flag only AMBIGUOUS provenance — a conflicting binding — so a
              // later pass can drop it; literal/inferred targets stay unmarked to
              // avoid churning every existing api-call fixture.
              ...(resolved.confidence === "AMBIGUOUS"
                ? { targetConfidence: resolved.confidence }
                : {}),
              ...bodyOf(callName, positional, firstArg),
              ...readsFor(node, fnName),
            }));
            emittedApiCall = true;
          }
        }

        // Message queues — amqplib channel ops + kafkajs producer/consumer.
        // These are the broker endpoints of a screen→…→event trace.
        if (!emittedApiCall && fn && fn.type === "member_expression") {
          const recv = fn.childForFieldName("object")?.text ?? "";
          const mqArgs = node.childForFieldName("arguments")?.namedChildren ?? [];
          const line = node.startPosition.row + 1;
          const channelish = MQ_CHANNEL_RECEIVER_RE.test(recv);

          // amqplib: ch.sendToQueue("tasks", buf) / ch.publish("ex", "key", buf)
          // / ch.consume("tasks", handler).
          if (fnName === "sendToQueue" || (fnName === "publish" && channelish)) {
            const routingKey = fnName === "publish" ? literalString(mqArgs[1] ?? null) : null;
            sources.push(this.ds({
              kind: "queue-publish",
              name: `AMQP: ${fnName}`,
              target: literalString(mqArgs[0] ?? null),
              ...(routingKey ? { entity: routingKey } : {}),
              line,
            }));
            return;
          }
          if (fnName === "consume" && channelish) {
            sources.push(this.ds({
              kind: "queue-consume",
              name: "AMQP: consume",
              target: literalString(mqArgs[0] ?? null),
              line,
            }));
            return;
          }

          // BullMQ / Bull: queue.add("job", data) publishes; Bull's queue.process(fn) consumes.
          if (fnName === "add" || fnName === "addBulk" || fnName === "process") {
            const mq = (this.mq ??= mqEvidence(this.sourceText));
            const queue = mq.bullQueues && recv ? mq.bullQueues.get(recv.replace(/^this\./, "")) : undefined;
            if (queue) {
              const job = fnName === "add" ? literalString(mqArgs[0] ?? null) : null;
              sources.push(this.ds({
                kind: fnName === "process" ? "queue-consume" : "queue-publish",
                name: `BullMQ: ${fnName}`,
                target: queue,
                ...(job ? { entity: job } : {}),
                line,
              }));
              return;
            }
          }
          // Socket.IO: socket.emit("event", …) publishes; socket.on("event", handler) consumes.
          if (fnName === "emit" || fnName === "on" || fnName === "once") {
            // `socket.on("a", f).on("b", g)`: each link of the chain listens on the same socket.
            const root = memberRoot(fn) ?? onChainRoot(fn);
            const event = literalString(mqArgs[0] ?? null);
            if (root && event && SOCKET_RECEIVER_RE.test(root) && !SOCKET_IO_RESERVED.has(event) && (this.mq ??= mqEvidence(this.sourceText)).socketIo) {
              sources.push(this.ds({
                kind: fnName === "emit" ? "queue-publish" : "queue-consume",
                name: `Socket.IO: ${fnName}`,
                target: event,
                // A link of a chain is on the line of its own `.on`.
                line: (fn.childForFieldName("property")?.startPosition.row ?? line - 1) + 1,
              }));
              return;
            }
          }

          // NestJS events: `this.eventEmitter.emit("order.created", payload)`.
          const mqev = (this.mq ??= mqEvidence(this.sourceText));
          if (fnName === "emit" && mqev.nestEvents && /eventEmitter|eventBus/i.test(recv)) {
            const event = literalString(mqArgs[0] ?? null);
            if (event) {
              sources.push(this.ds({ kind: "queue-publish", name: "NestJS: emit", target: event, line }));
              return;
            }
          }
          // An in-process emitter: `bus.emit("order.created", o)` publishes, `bus.on("order.created", fn)` consumes.
          if (fnName === "emit" || fnName === "on" || fnName === "once" || fnName === "addListener") {
            const root = memberRoot(fn) ?? recv;
            const event = literalString(mqArgs[0] ?? null);
            const leafRecv = recv.replace(/^this\./, "");
            const emitterLike = mqev.emitters.has(recv) || mqev.emitters.has(leafRecv) || EMITTER_NAME_RE.test(leafRecv);
            if (event && emitterLike && !NOT_A_CHANNEL_RE.test(root) && !(fnName !== "emit" && mqArgs.length < 2)) {
              sources.push(this.ds({ kind: fnName === "emit" ? "queue-publish" : "queue-consume", name: `EventEmitter: ${fnName}`, target: event, line }));
              return;
            }
            // A typed manager subscribing to several events at once: `events.on({ ClubUpdate: refresh, AuthLogout: () => … })`.
            if (fnName !== "emit" && emitterLike && !NOT_A_CHANNEL_RE.test(root) && mqArgs.length === 1 && mqArgs[0]!.type === "object") {
              const keyed = mqArgs[0]!.namedChildren.filter((p) => p.type === "pair" || p.type === "shorthand_property_identifier" || p.type === "method_definition");
              for (const p of keyed) {
                const key = p.type === "shorthand_property_identifier" ? p.text : (p.childForFieldName("key") ?? p.childForFieldName("name"))?.text.replace(/^['"]|['"]$/g, "");
                if (key && /^[\w:.-]+$/.test(key)) sources.push(this.ds({ kind: "queue-consume", name: `EventEmitter: ${fnName}`, target: key, line: p.startPosition.row + 1 }));
              }
              if (keyed.length > 0) return;
            }
          }
          // Redis pub/sub: `pub.publish("orders", msg)` / `sub.subscribe("orders", …)`, in a file that imports a client.
          if (mqev.redis && (fnName === "publish" || fnName === "subscribe" || fnName === "psubscribe" || fnName === "sSubscribe")) {
            const channel = literalString(mqArgs[0] ?? null);
            if (channel) {
              sources.push(this.ds({ kind: fnName === "publish" ? "queue-publish" : "queue-consume", name: `Redis: ${fnName}`, target: channel, line }));
              return;
            }
          }
          // AWS SDK v2: `sqs.sendMessage({ QueueUrl })`, `sns.publish({ TopicArn })`; sqs-consumer `Consumer.create({ queueUrl })`.
          const v2 = AWS_V2_METHODS.get(fnName) ?? (fnName === "publish" && /sns/i.test(recv) ? { kind: "queue-publish" as const, key: "TopicArn", name: "SNS: publish" } : undefined);
          if (v2 && mqArgs[0]?.type === "object") {
            const target = queueTarget(objectPropValue(mqArgs[0], v2.key));
            if (target) {
              sources.push(this.ds({ kind: v2.kind, name: v2.name, target, line }));
              return;
            }
          }
          if (fnName === "create" && recv === "Consumer" && mqArgs[0]?.type === "object") {
            const target = queueTarget(objectPropValue(mqArgs[0], "queueUrl"));
            if (target) {
              sources.push(this.ds({ kind: "queue-consume", name: "SQS: consumer", target, line }));
              return;
            }
          }

          // kafkajs: producer.send({ topic, messages }) /
          // consumer.subscribe({ topic } | { topics: [...] }).
          const descriptor = mqArgs[0]?.type === "object" ? mqArgs[0]! : null;
          if (descriptor && fnName === "send" && MQ_PRODUCER_RECEIVER_RE.test(recv)) {
            const topic = literalString(objectPropValue(descriptor, "topic"));
            if (topic) {
              sources.push(this.ds({ kind: "queue-publish", name: "Kafka: send", target: topic, line }));
              return;
            }
          }
          if (descriptor && fnName === "subscribe" && MQ_CONSUMER_RECEIVER_RE.test(recv)) {
            const topics: string[] = [];
            const single = literalString(objectPropValue(descriptor, "topic"));
            if (single) topics.push(single);
            const list = objectPropValue(descriptor, "topics");
            if (list?.type === "array") {
              for (const el of list.namedChildren) {
                const t = literalString(el);
                if (t) topics.push(t);
              }
            }
            for (const topic of topics) {
              sources.push(this.ds({ kind: "queue-consume", name: "Kafka: subscribe", target: topic, line }));
            }
            if (topics.length > 0) return;
          }
        }

        // React state hooks
        if (STATE_HOOKS.has(fnName)) {
          sources.push(this.ds({
            kind: "state",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // React useEffect — scan callback for calls
        if (fnName === "useEffect" || fnName === "useLayoutEffect") {
          sources.push(this.ds({
            kind: "state",
            name: fnName,
            target: null,
            calls: getCallbackCalls(node),
            line: node.startPosition.row + 1,
          }));
        }

        // Context hooks
        if (CONTEXT_HOOKS.has(fnName)) {
          const args = node.childForFieldName("arguments");
          const target = args?.child(1)?.text ?? null;
          sources.push(this.ds({
            kind: "context",
            name: fnName,
            target,
            line: node.startPosition.row + 1,
          }));
        }

        // Store hooks
        if (STORE_HOOKS.has(fnName)) {
          sources.push(this.ds({
            kind: "store",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
          // SWR's key IS the request: `useSWR('/api/user', fetcher)` hands the
          // key to a fetcher that takes it as a parameter, so the URL is only
          // ever visible here. (A react-query key is a cache label, not a URL —
          // its request is in `queryFn`, which the call graph already follows.)
          if (fnName === "useSWR" || fnName === "useSWRImmutable") {
            let key = node.childForFieldName("arguments")?.namedChildren[0] ?? null;
            if (key?.type === "array") key = key.namedChildren[0] ?? null; // useSWR(['/api/x', token], …)
            const resolved = key ? this.resolveUrlArg(key) : null;
            if (resolved && looksLikeUrl(resolved.url)) {
              sources.push(this.ds({
                kind: "api-call",
                name: "GET",
                target: resolved.url,
                line: node.startPosition.row + 1,
                ...(resolved.baseEnv ? { baseEnv: resolved.baseEnv } : {}),
              }));
            }
          }
        }

        // Vue Composition API reactive sources
        if (VUE_COMPOSITION_SOURCES.has(fnName)) {
          sources.push(this.ds({
            kind: "state",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // Vue watchers — scan callback for calls
        if (VUE_WATCHERS.has(fnName)) {
          const args = node.childForFieldName("arguments");
          const target = args?.child(1)?.text ?? null;
          sources.push(this.ds({
            kind: "state",
            name: fnName,
            target,
            calls: getCallbackCalls(node),
            line: node.startPosition.row + 1,
          }));
        }

        // Vue lifecycle hooks — scan callback for calls
        if (VUE_LIFECYCLE.has(fnName)) {
          sources.push(this.ds({
            kind: "state",
            name: fnName,
            target: null,
            calls: getCallbackCalls(node),
            line: node.startPosition.row + 1,
          }));
        }

        // Vue <script setup> compiler macros
        if (VUE_MACROS.has(fnName)) {
          // `defineProps({ title, … })` declares the component's props: one row each, by name.
          const props = fnName === "defineProps" ? declaredProps(node) : [];
          for (const name of props.length > 0 ? props : [fnName]) {
            sources.push(this.ds({
              kind: "prop",
              name,
              target: null,
              line: node.startPosition.row + 1,
            }));
          }
        }

        // ORM calls — prisma.user.findMany(), userRepo.save(user), Model.findOne()
        // Record the full receiver chain (`prisma.user.findUnique`) as the name so
        // the model/table (`user`) is visible and the import-index enrichment can
        // resolve `target` from the root identifier (`prisma` → its db module).
        // Veto: a `find` whose first argument is a function is `Array.prototype.find`
        // on a PascalCase-named collection (`const Product = […]; Product.find(p => …)`),
        // not a Mongoose query (whose first arg is a filter object/id) — see isOrmCall.
        // Kysely: the table is the string the clause verb takes —
        // `this.db.selectFrom('asset')`, `.insertInto('asset_exif')`,
        // `.updateTable('user')`, `.deleteFrom('session')` (an alias
        // `'asset as a'` is cut). The chain's root is usually `this.db`, which
        // no root-name rule trusts, and the verbs are Kysely's alone — so the
        // table literal is the evidence.
        const kyselyArg = fnName && KYSELY_TABLE_VERBS.has(fnName) ? literalString(node.childForFieldName("arguments")?.namedChildren[0] ?? null) : null;
        const kyselyMatch = kyselyArg ? /^([A-Za-z_]\w*(?:\.\w+)*)(?:\s+as\s+\w+)?$/.exec(kyselyArg) : null;
        // A common table expression the query defines (`.with('today', (qb) => …).selectFrom('today')`) is no table.
        const kysely = kyselyMatch && !(this.kyselyCtes ??= new Set([...this.sourceText.matchAll(/\.with(?:Recursive)?\s*\(\s*['"`](\w+)/g)].map((m) => m[1]!))).has(kyselyMatch[1]!) ? kyselyMatch : null;
        // Raw SQL to a driver: `pool.query("SELECT … FROM todos")`. The
        // statement names the table, whatever the receiver is called.
        const rawSql = !emittedApiCall && fnName && RAW_SQL_VERBS.has(fnName)
          ? rawSqlAccess(node.childForFieldName("arguments")?.namedChildren[0] ?? null)
          : null;
        // A client built from an SDK: a vector store's collection operations
        // are its data access; any other SDK (`openai.embeddings.create`, an
        // MCP `client.callTool`) is not a database, whatever its verbs.
        const sdk = !emittedApiCall && fn?.type === "member_expression" && ormChain ? this.clientKind(ormChain) : null;
        if (sdk === "vector") {
          const op = vectorStoreAccess(fnName, node);
          if (op) {
            sources.push(this.ds({
              kind: "database",
              name: ormChain!,
              target: op.collection,
              ...(op.collection ? { entity: op.collection } : {}),
              line: node.startPosition.row + 1,
              access: op.access,
            }));
          }
          return;
        }
        if (sdk === "sdk") return;
        // Supabase: `supabase.from("posts").select(…)` — the table is the
        // argument, the access the verb chained after it.
        const supabase = !emittedApiCall && !rawSql && fnName === "from" ? supabaseTable(node, fn) : null;
        if (supabase) {
          sources.push(this.ds({
            kind: "database",
            name: `supabase.from.${supabase.verb ?? "query"}`,
            target: supabase.table,
            entity: supabase.table,
            line: node.startPosition.row + 1,
            ...(supabase.access ? { access: supabase.access } : {}),
          }));
        } else if (rawSql) {
          sources.push(this.ds({
            kind: "database",
            // A chain split over lines (`db\n  .prepare(…)`) reads as one name.
            name: (ormChain ?? fnName!).replace(/\s+/g, ""),
            target: rawSql.table,
            entity: rawSql.table,
            line: node.startPosition.row + 1,
            ...(rawSql.access ? { access: rawSql.access } : {}),
          }));
        } else if (!emittedApiCall && kysely) {
          const table = kysely[1]!.split(".").pop()!;
          sources.push(this.ds({
            kind: "database",
            name: ormChain ?? `kysely.${fnName}`,
            target: table,
            entity: table,
            line: node.startPosition.row + 1,
            access: fnName === "selectFrom" ? "read" : "write",
          }));
        } else if (!emittedApiCall && ormChain && fnName && DOCUMENT_WRITES.has(fnName) && /^[a-z_$][\w$]*\.\w+$/.test(ormChain) && localDocumentModel(node, ormChain.split(".")[0]!)) {
          // `const club = await Club.findById(id); … await club.save()`: the document's model is written.
          const model = localDocumentModel(node, ormChain.split(".")[0]!)!;
          sources.push(this.ds({ kind: "database", name: ormChain, target: model, entity: model, line: node.startPosition.row + 1, access: "write" }));
        } else if (
          !emittedApiCall &&
          ormChain &&
          isOrmCall(ormChain) &&
          !(fnName === "find" && firstArgIsFunction(node)) &&
          this.hasOrmEvidence(ormChain)
        ) {
          const access = fnName ? ormAccessKind(fnName) : undefined;
          const table = drizzleTable(node, fnName);
          sources.push(this.ds({
            kind: "database",
            name: ormChain,
            target: null,
            ...(table ? { entity: table } : {}),
            line: node.startPosition.row + 1,
            ...(access ? { access } : {}),
          }));
        }
      }
    }

    // HTTP request-descriptor object literal: { method: "GET", url: "/api/x" }.
    // Covers axios-config calls and code-generated clients (e.g. Kubb) where the
    // endpoint literal lives in a `url` property rather than a string argument —
    // including the URL-builder helper `{ method, url: `/api/x` }` whose value is
    // referenced indirectly at the call site.
    if (node.type === "object") {
      // `type` is jQuery's spelling of the method (`$.ajax({ type: 'POST', url })`);
      // either only counts when its value IS an HTTP verb.
      const verb = literalString(objectPropValue(node, "method")) ?? literalString(objectPropValue(node, "type"));
      // …or the verb is the call the descriptor is handed to: hey-api's
      // generated `(options.client ?? client).post({ url: '/x', ...options })`.
      const callee = node.parent?.type === "arguments" ? calleeLeaf(node.parent.parent?.childForFieldName("function") ?? null) : null;
      const method = verb && HTTP_VERBS.has(verb.toLowerCase())
        ? verb.toLowerCase()
        : callee && HTTP_VERBS.has(callee.toLowerCase()) && objectPropValue(node, "url")
          ? callee.toLowerCase()
          : null;
      // `path` is Node's `http.request({ method, path })` — trusted only beside a
      // verb, because a router location (`router.push({ path, params })`) has one too.
      const urls = this.descriptorUrls(node, "url");
      // A `path` descriptor (`{ method, path }`, `{ path, type: "delete" }`) is
      // also a route table entry, a mock or a menu item; it is a request only
      // when it is handed to an HTTP client (`http.request({ method, path })`).
      if (urls.length === 0 && method && this.passedToHttpClient(node)) urls.push(...this.descriptorUrls(node, "path"));
      const url = urls[0] ?? null;
      // A `method` sibling distinguishes a real request descriptor
      // (`{ method, url }`) from query/mutation cache keys and other metadata
      // objects that merely carry a `url` (`[{ url }] as const`). Without one,
      // a descriptor handed to a call with request-shaped company
      // (`createAjaxRequest({ url: '/calendar', data })`) is still a request —
      // a GET by jQuery's default, left unnamed so the linker matches on path.
      // A `handler` makes it the opposite: an inbound route config
      // (`fastify.route({ method, url, handler })`).
      // An RTK Query endpoint's `{ url, method }` is the endpoint's own row (rtkCall).
      if (url && !hasProp(node, "handler") && !this.inRtkQuery(node)) {
        const requestShaped =
          !method &&
          node.parent?.type === "arguments" &&
          (looksLikeUrl(url) || isParamHole(url, node)) &&
          (REQUEST_KEYS.some((k) => hasProp(node, k)) || isJQueryAjax(node.parent.parent?.childForFieldName("function") ?? null) ||
            // Handed to a function named for a request (`request<T>({ url })`, `apiRequest({ url })`).
            REQUEST_CALLEE_RE.test(callee ?? ""));
        if (method || requestShaped) {
          // The instance the descriptor is handed to (`apiClient.get({ url })`,
          // hey-api's `(options?.client ?? client).get(…)`): its base is prepended later.
          const callFn = node.parent?.type === "arguments" ? node.parent.parent?.childForFieldName("function") : null;
          const client = callFn?.type === "member_expression" ? memberRoot(callFn) : null;
          const descriptorBody = objectPropValue(node, "data") ?? objectPropValue(node, "json") ?? objectPropValue(node, "body");
          const descriptorSchema = descriptorBody ? bodySchema(descriptorBody) : null;
          sources.push(this.ds({
            kind: "api-call",
            name: method ?? "request",
            target: url,
            line: node.startPosition.row + 1,
            ...(descriptorSchema ? { requestBody: descriptorSchema } : {}),
            ...(urls.length > 1 ? { targetAlternatives: urls.slice(1) } : {}),
            ...(client && !HTTP_ROOTS.has(client.toLowerCase()) && !GLOBAL_RECEIVERS.has(client) ? { client } : {}),
          }));
        }
      }
    }

    // A generated OpenAPI client's operation (see generated-clients.ts).
    if (node.type === "variable_declarator" && this.generatedClient) {
      const op = generatedClientCall(node);
      if (op) sources.push(op);
    }

    // process.env access
    if (node.type === "member_expression") {
      const obj = node.childForFieldName("object");
      if (obj?.text === "process.env" || obj?.text === "import.meta.env") {
        const prop = node.childForFieldName("property");
        sources.push(this.ds({
          kind: "env",
          name: prop?.text ?? "ENV",
          target: node.text,
          line: node.startPosition.row + 1,
        }));
      }
    }
  }
}

/**
 * String/template literal text of a value node, unwrapping TS expression
 * wrappers (`url: `/api/x` as const`, `(...)`, `...!`). Returns null when the
 * value isn't a literal (e.g. `url: getXUrl().url.toString()`).
 */
function literalString(node: Node | null): string | null {
  let n = node;
  while (n) {
    if (
      n.type === "as_expression" ||
      n.type === "satisfies_expression" ||
      n.type === "parenthesized_expression" ||
      n.type === "non_null_expression"
    ) {
      n = n.namedChild(0);
      continue;
    }
    // `` `/users/{id}`.replace('{id}', id) `` — the literal before the
    // substitution is the template; its `{id}` stays a parameter.
    const fn = n.type === "call_expression" ? n.childForFieldName("function") : null;
    if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "replace") {
      n = fn.childForFieldName("object");
      continue;
    }
    break;
  }
  if (n && (n.type === "string" || n.type === "template_string")) {
    return stripQuotes(n.text);
  }
  return null;
}

/** Value node of `obj`'s property named `key` (handles bare and quoted keys). */
/**
 * The literal HTTP verb in a request's options argument — an object, or a
 * helper call wrapping one (`json({ ...opts, method: "POST" })`) — else null.
 */
/** Verbs whose second argument is the body (`axios.post(url, data)`); `get`/`delete` take config there. */
const BODY_VERBS = new Set(["post", "put", "patch"]);

/**
 * The body a call states: the second argument of a body verb on a client
 * (`axios.post(url, data, config)`), or `body`/`data`/`json` in fetch-style
 * options (`fetch(url, { method: "POST", body: JSON.stringify(dto) })`).
 */
function bodyOf(verb: string, positional: readonly Node[], urlArg: Node | null): { requestBody?: JsonSchemaNode } {
  // Node wrappers are fresh per access: compare positions, not identity.
  const i = urlArg ? positional.findIndex((p) => p.startIndex === urlArg.startIndex) : 0;
  const after = positional[i + 1];
  if (!after) return {};
  let value: Node | null = null;
  if (BODY_VERBS.has(verb.toLowerCase()) && !isOptionsObject(after)) value = after;
  else if (after.type === "object") value = objectPropValue(after, "body") ?? objectPropValue(after, "data") ?? objectPropValue(after, "json");
  const schema = value ? bodySchema(value) : null;
  return schema ? { requestBody: schema } : {};
}

/** A fetch-style options object (`{ method, headers, body }`) rather than a body. */
function isOptionsObject(n: Node): boolean {
  return n.type === "object" && ["method", "headers", "body", "credentials", "signal"].some((k) => hasProp(n, k)) && !hasProp(n, "data");
}

/**
 * A request body's schema from what the source states: an object literal
 * (through `JSON.stringify(…)`, a local `const` initializer, `as` casts),
 * typed by its literal values; anything else yields null. A spread makes the
 * object open; a value that cannot be typed is `{}`.
 */
function bodySchema(n: Node, depth = 0): JsonSchemaNode | null {
  if (depth > 4) return {};
  let v: Node = n;
  while (v.type === "parenthesized_expression" || v.type === "as_expression" || v.type === "satisfies_expression" || v.type === "non_null_expression") {
    v = v.namedChild(0) ?? v;
    if (v === n) break;
  }
  if (v.type === "call_expression" && v.childForFieldName("function")?.text === "JSON.stringify") {
    const inner = v.childForFieldName("arguments")?.namedChildren[0];
    return inner ? bodySchema(inner, depth + 1) : null;
  }
  if (v.type === "identifier") {
    const init = localInitializer(v);
    return init && init.type === "object" ? bodySchema(init, depth + 1) : null;
  }
  if (v.type !== "object") return null;
  const properties: Record<string, JsonSchemaNode> = {};
  let open = false;
  for (const c of v.namedChildren) {
    if (c.type === "shorthand_property_identifier") properties[c.text] = typeOfValue(localInitializer(c), depth);
    else if (c.type === "pair") {
      const k = c.childForFieldName("key");
      const key = k ? (k.type === "string" ? stripQuotes(k.text) : k.type === "property_identifier" ? k.text : null) : null;
      if (key) properties[key] = typeOfValue(c.childForFieldName("value"), depth);
      else open = true;
    } else if (c.type === "spread_element") open = true;
  }
  return { type: "object", properties, ...(open ? { additionalProperties: true } : {}) };
}

/** A literal value's schema; `{}` for what the source does not type. */
function typeOfValue(v: Node | null, depth: number): JsonSchemaNode {
  if (!v) return {};
  switch (v.type) {
    case "string":
    case "template_string":
      return { type: "string" };
    case "number":
      return /[.eE]/.test(v.text) ? { type: "number" } : { type: "integer" };
    case "true":
    case "false":
      return { type: "boolean" };
    case "null":
      return { nullable: true };
    case "array": {
      const first = v.namedChildren[0];
      return { type: "array", ...(first ? { items: typeOfValue(first, depth + 1) } : {}) };
    }
    case "object":
      return bodySchema(v, depth + 1) ?? {};
    default:
      return {};
  }
}

/** The initializer of a `const`/`let` of this name declared in an enclosing scope before `at`. */
function localInitializer(at: Node): Node | null {
  const name = at.text;
  for (let p: Node | null = at.parent; p; p = p.parent) {
    if (!FUNCTION_SCOPES.has(p.type) && p.type !== "program" && p.type !== "statement_block") continue;
    for (const stmt of p.type === "statement_block" || p.type === "program" ? p.namedChildren : p.childForFieldName("body")?.namedChildren ?? []) {
      if (stmt.startIndex >= at.startIndex) break;
      if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
      for (const d of stmt.namedChildren) {
        if (d.type === "variable_declarator" && d.childForFieldName("name")?.text === name) return d.childForFieldName("value");
      }
    }
  }
  return null;
}

function optionsMethod(arg: Node | undefined): string | null {
  let obj = arg ?? null;
  if (obj?.type === "call_expression") obj = obj.childForFieldName("arguments")?.namedChildren[0] ?? null;
  if (obj?.type !== "object") return null;
  const verb = literalString(objectPropValue(obj, "method"));
  return verb && HTTP_VERBS.has(verb.toLowerCase()) ? verb.toLowerCase() : null;
}

/** An init object literal with no `method` and no spread that could bring one. */
function statesNoMethod(arg: Node | undefined): boolean {
  return arg?.type === "object" && !hasProp(arg, "method") && !arg.namedChildren.some((c) => c.type === "spread_element");
}

/** Whether an object literal has this key, as a pair or a shorthand (`{ handler }`). */
function hasProp(obj: Node, key: string): boolean {
  if (objectPropValue(obj, key)) return true;
  return obj.namedChildren.some((c) => c.type === "shorthand_property_identifier" && c.text === key);
}

function objectPropValue(obj: Node, key: string): Node | null {
  for (const pair of obj.children) {
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (!k) continue;
    const keyText = k.type === "string" ? stripQuotes(k.text) : k.text;
    if (keyText === key) return pair.childForFieldName("value");
  }
  return null;
}

/** Nodes that open a scope for `const` / `let` / `var` bindings. */
const FUNCTION_SCOPES = new Set([
  "function_declaration",
  "function_expression",
  "function",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

interface UrlBinding {
  start: number;
  /** Node id of the enclosing function, or of the program for a module binding. */
  scope: number;
  value: Node;
}

/**
 * The file's `const/let/var X = <…>` bindings, resolved where they are USED.
 * Real Vue/React data layers hoist endpoints into module consts — frequently
 * `import.meta.env.VITE_X ?? '/site/cui_checkout_json'` — and Angular services
 * build `let url = this.baseUrl + '…'` in each method, so a `fetch(X)` needs
 * the binding that is in scope at the call: the nearest enclosing function's
 * own declaration before it, else an outer function's, else the module's. A
 * parameter of that name shadows everything outside it. (The file-wide map
 * this replaced kept one binding per name, so three methods each posting to
 * their own `url` all got the last method's URL.)
 *
 * Values fold through the symbolic value resolver, so a URL assembled by
 * concatenation across several bindings (`const url = base + '/api/' + v`) or
 * on an env base (`import.meta.env.VITE_API + '/api'`) resolves; a leading
 * env/runtime base is stripped to keep the path app-relative (its env var in
 * `baseEnv`). Only URL-shaped values count.
 *
 * Built lazily — the first time a URL argument is an identifier or template —
 * so the overwhelmingly common `fetch('/x')` never pays for the walk.
 */
class UrlBindings {
  private readonly byName = new Map<string, UrlBinding[]>();
  private readonly folded = new Map<number, ResolvedUrl | null>();
  private readonly scope: ReturnType<typeof buildScope>;

  constructor(private readonly root: Node) {
    this.scope = buildScope(root, { logical: true });
    const stack: Array<[Node, number]> = [[root, root.id]];
    while (stack.length > 0) {
      const [n, scope] = stack.pop()!;
      if (n.type === "variable_declarator") {
        const name = n.childForFieldName("name");
        const value = n.childForFieldName("value");
        if (name?.type === "identifier" && value) {
          const list = this.byName.get(name.text) ?? [];
          list.push({ start: n.startIndex, scope, value });
          this.byName.set(name.text, list);
        }
      }
      const inner = FUNCTION_SCOPES.has(n.type) ? n.id : scope;
      for (const c of n.children) stack.push([c, inner]);
    }
    for (const list of this.byName.values()) list.sort((a, b) => a.start - b.start);
  }

  lookup(name: string, at: Node): ResolvedUrl | null {
    const b = this.binding(name, at);
    return b ? this.fold(b) : null;
  }

  /** The initializer of the binding `name` names at `at`. */
  valueOf(name: string, at: Node): Node | null {
    return this.binding(name, at)?.value ?? null;
  }

  private binding(name: string, at: Node): UrlBinding | null {
    const list = this.byName.get(name);
    if (!list) return null;
    for (let p: Node | null = at.parent; p; p = p.parent) {
      if (!FUNCTION_SCOPES.has(p.type)) continue;
      let pick: UrlBinding | null = null;
      for (const b of list) if (b.scope === p.id && b.start < at.startIndex) pick = b;
      if (pick) return pick;
      if (declaresParam(p, name)) return null;
    }
    // Module scope: a function body runs after the module has initialized, so
    // a module binding declared below its use still counts.
    const mod = list.filter((b) => b.scope === this.root.id);
    return [...mod].reverse().find((b) => b.start < at.startIndex) ?? mod[0] ?? null;
  }

  private fold(b: UrlBinding): ResolvedUrl | null {
    if (this.folded.has(b.start)) return this.folded.get(b.start)!;
    let out: ResolvedUrl | null = null;
    const folded = foldValue(astToValueExpr(b.value, { logical: true }), this.scope, { envMode: "name" });
    if (folded.text != null) {
      const { url, baseEnv } = toAppRelativeUrl(folded.text);
      if (looksLikeUrl(url)) out = { url, confidence: folded.confidence, ...(baseEnv ? { baseEnv } : {}) };
    }
    this.folded.set(b.start, out);
    return out;
  }
}

/**
 * The path argument of the `URL` object a fetch argument stands for:
 * `url.toString()` / `url.href` / `String(url)` / `url` itself, where `url` is
 * declared in an enclosing function as `new URL(path, base)`. Null otherwise.
 */
function urlObjectPath(arg: Node): Node | null {
  let name: Node | null = null;
  if (arg.type === "identifier") name = arg;
  else if (arg.type === "member_expression" && arg.childForFieldName("property")?.text === "href") name = arg.childForFieldName("object");
  else if (arg.type === "call_expression") {
    const fn = arg.childForFieldName("function");
    if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "toString") name = fn.childForFieldName("object");
    else if (fn?.type === "identifier" && fn.text === "String") name = arg.childForFieldName("arguments")?.namedChildren[0] ?? null;
  }
  if (name?.type !== "identifier") return null;
  for (let p: Node | null = arg.parent; p; p = p.parent) {
    if (!FUNCTION_SCOPES.has(p.type) && p.type !== "program") continue;
    const found = findUrlConstruction(p, name.text, arg.startIndex);
    if (found) return found;
  }
  return null;
}

/** `const <name> = new URL(<path>, …)` declared in `scope` before `before`: its path node. */
function findUrlConstruction(scope: Node, name: string, before: number): Node | null {
  let out: Node | null = null;
  const visit = (n: Node): void => {
    if (n.startIndex >= before) return;
    if (n !== scope && FUNCTION_SCOPES.has(n.type)) return;
    if (n.type === "variable_declarator" && n.childForFieldName("name")?.text === name) {
      const v = n.childForFieldName("value");
      if (v?.type === "new_expression" && v.childForFieldName("constructor")?.text === "URL") {
        out = v.childForFieldName("arguments")?.namedChildren[0] ?? null;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(scope);
  return out;
}

/** Whether `name` is a parameter of a function enclosing `at`. */
function declaredParamInScope(name: string, at: Node): boolean {
  for (let p: Node | null = at.parent; p; p = p.parent) {
    if (FUNCTION_SCOPES.has(p.type) && declaresParam(p, name)) return true;
  }
  return false;
}

/** `${url}`… where `url` is a parameter of a function enclosing `at` — a request factory's URL. */
function isParamHole(url: string, at: Node): boolean {
  const m = /^\$\{([A-Za-z_$][\w$]*)\}/.exec(url);
  if (!m) return false;
  for (let p: Node | null = at.parent; p; p = p.parent) {
    if (FUNCTION_SCOPES.has(p.type) && declaresParam(p, m[1]!)) return true;
  }
  return false;
}

/** Whether a function node declares a parameter of this name. */
/** The strings parameter `name` of `fnNode` is typed as (`kind: "club" | "league"`), else null. */
function literalUnionParam(fnNode: Node, name: string): string[] | null {
  const params = fnNode.childForFieldName("parameters");
  for (const p of params?.namedChildren ?? []) {
    if ((p.type !== "required_parameter" && p.type !== "optional_parameter") || p.childForFieldName("pattern")?.text !== name) continue;
    const type = p.childForFieldName("type")?.namedChild(0);
    if (type?.type !== "union_type") return null;
    const out: string[] = [];
    const walk = (t: Node): boolean => {
      if (t.type === "union_type") return t.namedChildren.every(walk);
      const lit = t.type === "literal_type" ? t.namedChild(0) : null;
      if (lit?.type !== "string") return false;
      out.push(stripQuotes(lit.text));
      return true;
    };
    return walk(type) ? out : null;
  }
  return null;
}

function declaresParam(fnNode: Node, name: string): boolean {
  const params = fnNode.childForFieldName("parameters") ?? fnNode.childForFieldName("parameter");
  if (!params) return false;
  if (params.type === "identifier") return params.text === name;
  return new RegExp(`(^|[^\\w$])${escapeRegex(name)}([^\\w$]|$)`).test(params.text);
}

/**
 * Reconstruct a template literal as a URL, substituting `${id}` interpolations
 * found in the const map and reproducing every other part (literal fragments
 * and unresolved `${…}`) verbatim — so a template that references no known URL
 * const yields exactly its original text.
 */
function resolveTemplateUrl(tpl: Node, lookup: (name: string) => ResolvedUrl | null): string {
  let out = "";
  for (const part of tpl.children) {
    if (part.type === "`") continue;
    if (part.type === "template_substitution") {
      const inner = part.namedChild(0);
      const hit = inner && inner.type === "identifier" ? lookup(inner.text) : null;
      if (hit) {
        out += hit.url;
      } else {
        out += part.text; // reproduce `${…}` verbatim
      }
    } else {
      out += part.text; // string_fragment / escape_sequence
    }
  }
  return out;
}

/**
 * Whether a call's first positional argument is a function literal. Distinguishes
 * `Array.prototype.find(predicate)` (callback) from a Mongoose `Model.find(filter)`
 * (object/id/none) when the receiver is PascalCase and could be either.
 */
function firstArgIsFunction(callNode: Node): boolean {
  const a = callNode.childForFieldName("arguments")?.namedChild(0);
  return (
    !!a &&
    (a.type === "arrow_function" || a.type === "function_expression" || a.type === "function")
  );
}

/**
 * The receiver a method is called ON, one hop: `api.get` → "api",
 * `this.http.get` → "http". A longer chain (`request.params.get`) → null.
 */
function directReceiver(fn: Node): string | null {
  const obj = fn.childForFieldName("object");
  if (!obj) return null;
  if (obj.type === "identifier") return obj.text;
  if (obj.type === "parenthesized_expression") return defaultInstance(obj);
  if (obj.type === "member_expression" && obj.childForFieldName("object")?.type === "this") {
    return obj.childForFieldName("property")?.text ?? null;
  }
  return null;
}

/** Keys only a request descriptor carries beside its `url`. */
const REQUEST_KEYS = ["data", "body", "params", "queryParams", "headers", "dataType", "contentType", "traditional", "timeout"];
/** A project function named for sending a request, handed a `{ url }` descriptor. */
const REQUEST_CALLEE_RE = /^(?:request|\w+Request|sendRequest|httpRequest)$/;

/** Globals an HTTP root may hang off: jQuery's `$.ajax`, `window.fetch`. */
const GLOBAL_RECEIVERS = new Set(["$", "jQuery", "window", "globalThis", "self"]);

/** jQuery's Ajax shorthands → the HTTP method each sends (`getScript` loads code, `load` fills a selection). */
const JQUERY_SHORTHANDS = new Map([["get", "get"], ["post", "post"], ["getJSON", "get"]]);

/** The method of a jQuery Ajax shorthand called on the global itself (`$.post`, `jQuery.getJSON`), else null. */
function jqueryShorthandVerb(fn: Node | null, leaf: string): string | null {
  if (fn?.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  if (obj?.type !== "identifier" || (obj.text !== "$" && obj.text !== "jQuery")) return null;
  return JQUERY_SHORTHANDS.get(leaf) ?? null;
}

/** `$.ajax` / `jQuery.ajax`: whatever descriptor it is handed is a request (a GET when it names no `type`). */
function isJQueryAjax(fn: Node | null): boolean {
  if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "ajax") return false;
  const obj = fn.childForFieldName("object");
  return obj?.type === "identifier" && (obj.text === "$" || obj.text === "jQuery");
}

/** A receiver named like an HTTP client: `http`, `$http`, `httpClient`, `axios`, `$axios`, `api`, `apiService`, `requests`. */
const HTTP_RECEIVER_RE = /^\$?(http|axios|ky|got|api|request|requests)(client|service)?$/i;

/** Root identifier of a member chain: `apiClient.post` → "apiClient", `a.b.c` → "a". */
/** The identifier a chain of `.on(…)` / `.once(…)` calls starts from (`socket.on(…).on(…)` → `socket`). */
function onChainRoot(fn: Node): string | null {
  let obj = fn.childForFieldName("object");
  while (obj?.type === "call_expression") {
    const inner = obj.childForFieldName("function");
    if (inner?.type !== "member_expression" || !/^(?:on|once|off)$/.test(inner.childForFieldName("property")?.text ?? "")) return null;
    obj = inner.childForFieldName("object");
  }
  return obj?.type === "identifier" ? obj.text : null;
}

function memberRoot(fn: Node): string | null {
  let obj = fn.childForFieldName("object");
  while (obj && obj.type === "member_expression") obj = obj.childForFieldName("object");
  if (obj?.type === "parenthesized_expression") return defaultInstance(obj);
  return obj && obj.type === "identifier" ? obj.text : null;
}

/**
 * `(options?.client ?? client)` — a generated SDK's call on the caller's client
 * when one is passed, else on the module's own instance: that instance is the
 * client the call states.
 */
function defaultInstance(paren: Node): string | null {
  const inner = paren.namedChildren[0];
  if (inner?.type !== "binary_expression") return null;
  const op = inner.childForFieldName("operator")?.text;
  const right = inner.childForFieldName("right");
  return (op === "??" || op === "||") && right?.type === "identifier" ? right.text : null;
}

/** Leaf/callee name of a call's function node: `apiClient.post` → "post", `fetch` → "fetch". */
function calleeLeaf(fn: Node | null): string | null {
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null;
  }
  return null;
}

/** Object names that denote a server router, not an HTTP client. */
const SERVER_ROUTER_OBJECTS = new Set(["app", "router", "route", "server", "Router"]);

/** `const x = Router()`, `express.Router()`, `new Router()`, `express()`, `new Hono()`, `new Koa()`, `fastify()`, `new Elysia()`. */
const SERVER_ROUTER_INIT_RE = /(?:^|[\s,;({])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:new\s+)?(?:(?:express|koa|Koa)\s*\.\s*)?(?:Router|express|Hono|Koa|fastify|Fastify|Elysia)\s*(?:<[^>\n]*>)?\s*\(/g;

/**
 * Whether a verb call is a server-side route/middleware registration
 * (`app.get("/x", handler)`, `router.post(...)`) rather than an outbound call.
 * Signals: the receiver is a known router object, or a handler function is
 * passed as an argument (route handler / middleware).
 */
function isServerRouteDef(fn: Node, callNode: Node, routers: Set<string>): boolean {
  if (fn.type !== "member_expression") return false;
  const objRoot = (fn.childForFieldName("object")?.text ?? "").split(/[.[]/)[0]!;
  if (SERVER_ROUTER_OBJECTS.has(objRoot) || routers.has(objRoot)) return true;
  // A receiver named like an Express router/route (`productRouter.post(...)`,
  // `userRoute.get(...)`, `apiRoutes.delete(...)`) is an inbound route
  // registration even when the handler is an imported identifier
  // (`router.post("/x", authSeller, addProduct)`) rather than an inline function
  // — the literal `router` name is too narrow for the common `<name>Router`
  // convention, so the whole route file was being mis-read as outbound calls.
  if (/route(r|s)?$/i.test(objRoot)) return true;
  const args = callNode.childForFieldName("arguments");
  if (args) {
    for (const a of args.namedChildren) {
      if (isFunctionNode(a)) return true;
      // A wrapped handler: `asyncHandler(async (req, res) => …)`, `catchAsync(function (…) {…})`.
      if (a.type === "call_expression" && (a.childForFieldName("arguments")?.namedChildren ?? []).some(isFunctionNode)) return true;
    }
  }
  return false;
}

function isFunctionNode(n: Node): boolean {
  return n.type === "arrow_function" || n.type === "function_expression" || n.type === "function";
}

/** Packages whose clients call an API (LLM, payment, cloud, chat), never a database. */
const API_SDK_RE = /^(?:openai|@anthropic-ai\/|@modelcontextprotocol\/|stripe|@aws-sdk\/client-(?!dynamodb|rds|s3\b)|twilio|@slack\/|googleapis|@google\/genai|@google-cloud\/(?!firestore|spanner|bigquery|datastore)|@octokit\/|octokit|@sendgrid\/|resend|ollama|cohere-ai|@mistralai\/|groq-sdk|@huggingface\/|replicate)/;
/** Vector-store client packages and classes: their collections are data. */
const VECTOR_SDK_RE = /^(?:@qdrant\/|chromadb|weaviate-client|weaviate-ts-client|@pinecone-database\/|@zilliz\/milvus)/;
const VECTOR_CLIENT_CLASS_RE = /^(?:QdrantClient|ChromaClient|Pinecone|MilvusClient|WeaviateClient)$/;

/** Collection reads and writes of a vector-store client: `client.search("docs", …)`, `client.upsert("docs", …)`. */
const VECTOR_READS = /^(?:search|searchBatch|query|queryPoints|queryBatch|retrieve|scroll|count|recommend|discover|getCollection|get|collectionExists|facet)$/;
const VECTOR_WRITES = /^(?:upsert|delete|deletePoints|createCollection|recreateCollection|deleteCollection|updateCollection|setPayload|overwritePayload|deletePayload|clearPayload|updateVectors|deleteVectors|batchUpdate|createPayloadIndex|deletePayloadIndex|insert|add|update)$/;

function vectorStoreAccess(verb: string | null, call: Node): { collection: string | null; access: "read" | "write" } | null {
  if (!verb) return null;
  const access = VECTOR_READS.test(verb) ? "read" : VECTOR_WRITES.test(verb) ? "write" : null;
  if (!access) return null;
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  let collection: string | null = null;
  if (first && (first.type === "string" || first.type === "template_string")) collection = stripQuotes(first.text);
  else if (first?.type === "object") collection = literalString(objectPropValue(first, "collection_name") ?? objectPropValue(first, "collectionName") ?? objectPropValue(first, "name"));
  if (collection && !/^[\w.-]+$/.test(collection)) collection = null;
  return { collection, access };
}

/**
 * `supabase.from("posts").select()` on a Supabase client — a receiver named
 * for it, or `createClient(…)` from `@supabase/supabase-js` in the same chain.
 * The verb chained after `from` says read or write.
 */
function supabaseTable(call: Node, fn: Node | null): { table: string; verb: string | null; access?: "read" | "write" } | null {
  if (fn?.type !== "member_expression") return null;
  const recv = fn.childForFieldName("object")?.text ?? "";
  if (!/supabase/i.test(recv)) return null;
  const arg = call.childForFieldName("arguments")?.namedChildren[0];
  if (!arg || (arg.type !== "string" && arg.type !== "template_string")) return null;
  const table = stripQuotes(arg.text);
  if (!/^[A-Za-z_][\w.]*$/.test(table)) return null;
  const next = call.parent?.type === "member_expression" ? call.parent.childForFieldName("property")?.text ?? null : null;
  const access = next === "select" ? "read" : next && /^(?:insert|update|upsert|delete)$/.test(next) ? "write" : undefined;
  return { table, verb: next, ...(access ? { access } : {}) };
}

/** A named HTTP client: fetch, axios, http(Client), request, ajax, or a fetchX/httpX helper. */
function isHttpRoot(name: string): boolean {
  const lower = name.toLowerCase();
  return HTTP_ROOTS.has(lower) || lower.includes("fetch") || lower.includes("http");
}

/**
 * Whether a string argument looks like a request URL/path. Requires a slash (or
 * http scheme) so verb calls on non-clients are excluded — `Map.get("key")`,
 * `set.delete(`approve-${id}`)`, `params.get("tag")` have no path separator.
 */
function looksLikeUrl(s: string): boolean {
  return s.includes("/") || /^https?:/i.test(s);
}

/**
 * The stricter test for a call whose receiver says nothing about HTTP: the
 * argument must BE a request path — rooted (`/api/x`, `./x`), absolute
 * (`https://…`, `//host/x`) or a template hole in path position
 * (`${base}/users`) — not merely contain a slash. `cy.get("[data-x=a/b]")`,
 * `cache.get("user/1")` and `request("tools/call")` are not requests.
 */
function urlShaped(s: string): boolean {
  return /^(?:\.{0,2}\/|[a-z][\w+.-]*:\/\/|\$\{[^}]+\}\/)/i.test(s);
}

/** Receivers that are never HTTP clients, whatever their verb: Cypress, URL/query helpers, caches. */
const NON_HTTP_RECEIVERS = new Set([
  "cy", "searchParams", "params", "query", "headers", "formData", "map", "cache", "store",
  "localStorage", "sessionStorage", "storage", "registry", "seen", "visited",
]);

/**
 * DOM / JS-builtin receiver segments that share method names with ORM verbs
 * (`classList.remove`, `el.style.remove`, `arr.values()`, `document.…`,
 * `localStorage.…`) but are never database access. A chain whose receiver is one
 * of these is rejected before the leaf-method check, killing the dominant
 * false-positive class on vanilla-JS / DOM-heavy frontends (a phantom
 * `classList`/`document` "entity"). Lowercased comparison.
 */
const DOM_BUILTIN_RECEIVERS = new Set([
  "classlist", "style", "dataset", "document", "documentelement", "window",
  "location", "history", "navigator", "console", "localstorage", "sessionstorage",
  "math", "json", "object", "array", "string", "number", "boolean", "date",
  "promise", "map", "set", "weakmap", "weakset", "reflect", "symbol",
  "element", "node", "event", "e", "evt",
]);

/**
 * PascalCase identifiers that are JS/global builtins, NOT ORM models — used to
 * tell a model receiver (`Product.find`) from a builtin (`Promise.all`,
 * `Array.from`, `Object.keys`) when admitting the Array-colliding `find` verb.
 */
const CAP_BUILTINS = new Set([
  "Array", "Object", "Math", "JSON", "Promise", "Map", "Set", "WeakMap", "WeakSet",
  "Date", "String", "Number", "Boolean", "Symbol", "BigInt", "Reflect", "Proxy",
  "Error", "RegExp", "Function", "Infinity", "NaN", "Image", "Audio", "Intl",
  "Buffer", "JSON",
]);

/**
 * A receiver that reads like an ORM model class: a single PascalCase identifier
 * (`Product`, `User`, `OrderItem`) that isn't a JS builtin. Mongoose/Sequelize/
 * TypeORM models are referenced this way, so a model-colliding verb (`find`) on
 * such a receiver is a DB op, while the same verb on a plain collection
 * (`users.find(u => …)`) is not.
 */
/** Receiver segment named for a data-access object (`userRepo`, `orderModel`, `entityManager`, `em`). */
const ORM_SEGMENT_RE = /(Repo|Repository|repo|repository|Model|model|Dao|DAO|dao|EntityManager|entityManager|^em)$/;

function isModelLikeRoot(seg: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(seg) && !CAP_BUILTINS.has(seg);
}

/**
 * Heuristic: a call is an ORM operation when its leaf method is in ORM_METHODS
 * AND it's a member access (`x.findMany`, not bare `findMany`). The root-name
 * check (`prisma.x.findMany`) is a softer signal that also counts.
 */
function isOrmCall(name: string): boolean {
  if (!name.includes(".")) return false;
  const parts = name.split(".");
  const root = parts[0]!;
  // Express/Koa route registrations (`router.get`, `app.delete`, `router.post`)
  // share verb names with ORM methods (Drizzle `get`, Prisma `delete`) but are
  // never DB ops — exclude by receiver before the leaf-method check.
  if (SERVER_ROUTER_OBJECTS.has(root)) return false;
  // An HTTP client receiver (`axios.create`, `http.get`, `fetchClient.delete`)
  // is never an ORM — its verb/CRUD-shaped methods are HTTP, not DB.
  if (isHttpRoot(root)) return false;
  // A trusted ORM root (`db`, `prisma`, `*Repository`) makes the whole chain DB
  // access regardless of intermediate calls — `db.prepare("sql").all()`,
  // `repo.createQueryBuilder().getMany()`.
  const trustedRoot = ORM_ROOTS.has(root) || /Repository$/.test(root);
  // Otherwise the receiver must not be a DOM/builtin object (`navbar.classList.remove`,
  // `document.querySelector(...)`) or a fluent builtin chain (`s.split(' ').map(…)`)
  // — those share verb names with ORM CRUD but are DOM/array manipulation, the
  // dominant false-positive on vanilla-JS frontends (phantom `classList` entity).
  if (!trustedRoot) {
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (DOM_BUILTIN_RECEIVERS.has(seg.toLowerCase())) return false;
      if (seg.includes("(")) return false; // a call in the receiver chain → builtin fluent op
    }
  }
  const leaf = parts[parts.length - 1]!;
  // `delete` is also `Map`/`Set.prototype.delete` — `next.delete(id)`,
  // `this.byId.delete(key)` on local collections are the dominant phantom DB op
  // on React frontends. It counts only with ORM evidence somewhere in the
  // receiver chain: a trusted root, an ORM root or repository/model-shaped
  // segment (`ctx.prisma.user.delete`, `this.userRepo.delete`), or a model-like
  // static receiver (`User.delete(id)`).
  if (leaf === "delete") {
    return chainHasOrmEvidence(parts) || isModelLikeRoot(parts[parts.length - 2]!);
  }
  if (ORM_METHODS.has(leaf)) return true;
  // Bare `find` collides with `Array.prototype.find`, so it's a DB op only on a
  // model-like receiver — `Product.find({})` / `Order.find(query)` (Mongoose/
  // Sequelize statics), never `users.find(u => …)`. The immediate receiver is
  // the segment before the leaf.
  if (leaf === "find") {
    const receiver = parts[parts.length - 2];
    if (receiver && isModelLikeRoot(receiver)) return true;
  }
  if (trustedRoot) return true;
  return false;
}

/**
 * Drizzle names the table as the verb's argument — `db.insert(posts).values(…)`,
 * `db.update(schema.posts).set(…)`, `db.delete(posts).where(…)` — and the call
 * goes on as only Drizzle's does. Knex's `insert(rows)` never chains `.values`.
 */
function drizzleTable(node: Node, fnName: string | null): string | null {
  if (fnName !== "insert" && fnName !== "update" && fnName !== "delete") return null;
  const next = node.parent?.type === "member_expression" ? node.parent.childForFieldName("property")?.text : undefined;
  if (next !== "values" && next !== "set" && next !== "where" && next !== "returning") return null;
  const arg = node.childForFieldName("arguments")?.namedChildren[0];
  if (!arg || (arg.type !== "identifier" && arg.type !== "member_expression")) return null;
  return arg.text.split(".").pop()!;
}

/** Extract calls from the first callback argument of a call_expression node */
function getCallbackCalls(callNode: Node): CallInfo[] {
  const args = callNode.childForFieldName("arguments");
  if (!args) return [];
  for (const arg of args.children) {
    if (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function") {
      return extractCalls(arg, "typescript");
    }
  }
  return [];
}

/** The keys of a props object (`{ title: String }`) or the strings of a props array (`['title']`). */
function propNamesOf(value: Node | null | undefined): string[] {
  const names: string[] = [];
  if (value?.type === "object") {
    for (const p of value.namedChildren) {
      const key = optionKey(p);
      if (key) names.push(key);
    }
  } else if (value?.type === "array") {
    for (const s of value.namedChildren) if (s.type === "string") names.push(s.text.slice(1, -1));
  }
  return names.filter((n) => /^[\w$-]+$/.test(n));
}

/** The key of an object member: `key: v`, `'key': v`, shorthand `key`, or a method `key() {}`. */
function optionKey(member: Node): string | null {
  const key =
    member.type === "pair" || member.type === "method_definition"
      ? member.childForFieldName(member.type === "pair" ? "key" : "name")
      : member.type === "shorthand_property_identifier"
        ? member
        : null;
  if (!key || !(key.type === "property_identifier" || key.type === "string" || key.type === "shorthand_property_identifier")) return null;
  return key.text.replace(/^['"]|['"]$/g, "");
}

/**
 * The component options object: `export default {…}`, the argument of
 * `defineComponent(…)` / `Vue.extend(…)`, or the second of `Vue.component('x', …)` —
 * and only one that declares `props` or `data`, so a plain exported config is no component.
 */
function isOptionsComponent(obj: Node): boolean {
  const parent = obj.parent;
  let host = false;
  if (parent?.type === "export_statement") host = true;
  else if (parent?.type === "arguments") {
    const fn = parent.parent?.childForFieldName("function")?.text;
    host = fn === "defineComponent" || fn === "Vue.extend" || (fn === "Vue.component" && parent.namedChildren[1] === obj);
  }
  if (!host) return false;
  return obj.namedChildren.some((m) => {
    const k = optionKey(m);
    return k === "props" || k === "data";
  });
}

/** The keys `data` returns: `data() { return {…} }`, `data: () => ({…})`, `data: function () { return {…} }`. */
function dataKeysOf(member: Node): string[] {
  const fn: Node | null = member.type === "method_definition" ? member : member.type === "pair" ? member.childForFieldName("value") : null;
  if (!fn) return [];
  let body = fn.childForFieldName("body");
  if (body?.type === "parenthesized_expression") body = body.namedChildren[0] ?? null;
  let returned: Node | null = body?.type === "object" ? body : null;
  if (!returned && body?.type === "statement_block") {
    const ret = body.namedChildren.filter((c) => c.type === "return_statement").pop();
    const value = ret?.namedChildren[0] ?? null;
    returned = value?.type === "object" ? value : value?.type === "parenthesized_expression" && value.namedChildren[0]?.type === "object" ? value.namedChildren[0]! : null;
  }
  return returned ? returned.namedChildren.map(optionKey).filter((k): k is string => !!k && /^[\w$]+$/.test(k)) : [];
}

/**
 * The store keys a Vuex map helper names: `mapGetters('league', ['standings'])` →
 * `league/standings`, `mapGetters({ table: 'league/standings' })` → that string,
 * `mapState('league', { clubs: (s) => s.clubs })` → `league/clubs`, `mapGetters(['x'])` → `x`.
 */
function mappedStoreKeys(call: Node): string[] {
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment");
  const ns = args.length > 1 ? literalString(args[0]!) : null;
  if (args.length > 1 && ns === null) return [];
  const map = args[args.length - 1];
  const keyed = (k: string) => (ns ? `${ns}/${k}` : k);
  const out: string[] = [];
  if (map?.type === "array") {
    for (const el of map.namedChildren) {
      const k = literalString(el);
      if (k) out.push(keyed(k));
    }
  } else if (map?.type === "object") {
    for (const m of map.namedChildren) {
      const local = optionKey(m);
      if (!local) continue;
      const value = m.type === "pair" ? literalString(m.childForFieldName("value")) : null;
      out.push(keyed(value ?? local));
    }
  }
  return out;
}

/**
 * The prop names `defineProps` declares: the keys of its object argument
 * (`defineProps({ title: String })`), the strings of an array (`defineProps(['title'])`)
 * or the members of its type argument (`defineProps<{ title: string }>()`).
 */
function declaredProps(call: Node): string[] {
  const arg = call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment");
  const names: string[] = [];
  if (arg?.type === "object" || arg?.type === "array") {
    names.push(...propNamesOf(arg));
  } else if (!arg) {
    const typeArgs = call.childForFieldName("type_arguments") ?? call.namedChildren.find((c) => c.type === "type_arguments");
    const literal = typeArgs?.namedChildren.find((c) => c.type === "object_type");
    for (const m of literal?.namedChildren ?? []) {
      const key = m.type === "property_signature" ? m.childForFieldName("name") : null;
      if (key) names.push(key.text.replace(/^['"]|['"]$/g, ""));
    }
  }
  return names.filter((n) => /^[\w$-]+$/.test(n));
}
