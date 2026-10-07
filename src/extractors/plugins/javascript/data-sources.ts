import type { Node, Tree } from "web-tree-sitter";
import type { Confidence, DataSourceInfo, CallInfo, FileAnalysis, Language } from "../../../types/analysis.js";
import { DataSourceExtractor, type ProjectApiCall } from "../../data-sources/base.js";
import { resolveUrlBuilders } from "./url-builders.js";
import { extractCalls } from "../../shared/call-graph.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { foldValue, toAppRelativeUrl } from "../../shared/value-resolver.js";
import { astToValueExpr, buildScope } from "./value-capture.js";
import { extractGqlOperationCalls } from "../shared/graphql-operations.js";

/** A resolved api-call URL: the app-relative path plus recovered provenance. */
interface ResolvedUrl {
  url: string;
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
  "useQuery", "useSWR", "useInfiniteQuery", "useMutation",
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
  override resolveProject(calls: ProjectApiCall[], analyses: FileAnalysis[]): number {
    return resolveUrlBuilders(calls, analyses);
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

  override beginFile(tree: Tree, sourceText: string): void {
    this.root = tree.rootNode;
    this.urlBindings = null;
    this.sourceText = sourceText;
    this.gqlScanned = false;
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
    if (arg.type === "template_string") {
      const url = resolveTemplateUrl(arg, (name) => this.bindings()?.lookup(name, arg) ?? null);
      // A leftover `${…}` means the template couldn't be fully resolved.
      return { url, confidence: url.includes("${") ? "INFERRED" : "EXTRACTED" };
    }
    if (arg.type === "identifier") return this.bindings()?.lookup(arg.text, arg) ?? null;
    // A URL-builder helper call: `axios.get(requestUri('teamtalk', 'v4'))`.
    // Keep the call text verbatim (whitespace-collapsed) so a project-level pass
    // can substitute the helper's template and recover the concrete URL. Emitted
    // only on a trusted HTTP receiver (see visitNode) so a non-client verb call
    // isn't mistaken for one.
    if (arg.type === "call_expression") {
      return { url: arg.text.replace(/\s+/g, " ").trim(), confidence: "INFERRED" };
    }
    return null;
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // One-time gql-operation scan (no whole-file hook exists in the fused walk).
    if (!this.gqlScanned) this.scanGql(sources);

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

      if (fnName) {
        // HTTP call: fetch("/api/x"), axios.get("/api/x"), apiClient.post("/x").
        // Object-config calls (axios({url}), Kubb request({url})) are captured by
        // the request-descriptor `object` branch below.
        const isRoot = isHttpRoot(fnName);
        const isVerb = HTTP_VERBS.has(fnName.toLowerCase());
        // A verb call on a known HTTP-client receiver (`axios.get`,
        // `apiClient.post`, `this.http.delete`) is itself a strong HTTP signal —
        // trust it like a named root so the URL-shape check is relaxed and a
        // helper-built URL (`axios.get(requestUri(...))`, no literal slash) is
        // still captured. Only the receiver the verb is called ON counts, and
        // only a client-shaped name: trusting the root of any chain read
        // `request.params.get('page')` in a test predicate as a GET to "page".
        const recvRoot = fn && fn.type === "member_expression" ? memberRoot(fn) : null;
        const recv = fn && fn.type === "member_expression" ? directReceiver(fn) : null;
        const trustedReceiver = !!recv && (HTTP_RECEIVER_RE.test(recv) || /client$/i.test(recv));
        // `app.get("/x", handler)` / `router.post(...)` are inbound route
        // definitions (already captured as routes), not outbound calls — exclude.
        if ((isRoot || isVerb) && fn && !isServerRouteDef(fn, node)) {
          const args = node.childForFieldName("arguments");
          const firstArg = args && args.childCount > 1 ? args.child(1) : null;
          const resolved = firstArg ? this.resolveUrlArg(firstArg) : null;
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
          const exactRoot =
            HTTP_ROOTS.has(fnName.toLowerCase()) &&
            (fn.type === "identifier" || trustedReceiver || (!!recv && GLOBAL_RECEIVERS.has(recv)));
          const trusted = exactRoot || trustedReceiver;
          // A call-expression URL arg (a helper-built URL with no literal slash)
          // needs a STRICT HTTP signal — an exact client root (`fetch`/`axios`/…)
          // or a client member receiver (`axios.get`) — so a local data-fetcher
          // named `fetchX(localArg)` (matched by the fuzzy isHttpRoot) isn't read
          // as an HTTP call to a non-URL argument.
          const argIsCall = firstArg?.type === "call_expression";
          const strictHttp = exactRoot || trustedReceiver;
          if (
            resolved != null &&
            (looksLikeUrl(resolved.url) || (trusted && (!argIsCall || strictHttp)))
          ) {
            sources.push(this.ds({
              kind: "api-call",
              name: fnName,
              target: resolved.url,
              line: node.startPosition.row + 1,
              // Recovered env base (display only; `target` stays app-relative).
              ...(resolved.baseEnv ? { baseEnv: resolved.baseEnv } : {}),
              // The client instance (`apiClient.get(...)`): its base URL is
              // prepended by a project pass. Library roots (`axios`, `fetch`)
              // are not instances.
              ...(recvRoot && /^[A-Za-z_$][\w$]*$/.test(recvRoot) && !HTTP_ROOTS.has(recvRoot.toLowerCase())
                ? { client: recvRoot }
                : {}),
              // Flag only AMBIGUOUS provenance — a conflicting binding — so a
              // later pass can drop it; literal/inferred targets stay unmarked to
              // avoid churning every existing api-call fixture.
              ...(resolved.confidence === "AMBIGUOUS"
                ? { targetConfidence: resolved.confidence }
                : {}),
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
          sources.push(this.ds({
            kind: "prop",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // ORM calls — prisma.user.findMany(), userRepo.save(user), Model.findOne()
        // Record the full receiver chain (`prisma.user.findUnique`) as the name so
        // the model/table (`user`) is visible and the import-index enrichment can
        // resolve `target` from the root identifier (`prisma` → its db module).
        // Veto: a `find` whose first argument is a function is `Array.prototype.find`
        // on a PascalCase-named collection (`const Product = […]; Product.find(p => …)`),
        // not a Mongoose query (whose first arg is a filter object/id) — see isOrmCall.
        if (
          !emittedApiCall &&
          ormChain &&
          isOrmCall(ormChain) &&
          !(fnName === "find" && firstArgIsFunction(node))
        ) {
          const access = fnName ? ormAccessKind(fnName) : undefined;
          sources.push(this.ds({
            kind: "database",
            name: ormChain,
            target: null,
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
      const url = literalString(objectPropValue(node, "url"));
      const method = literalString(objectPropValue(node, "method"));
      // Require a `method` sibling: that's what distinguishes a real request
      // descriptor (`{ method, url }`) from query/mutation cache keys and other
      // metadata objects that merely carry a `url` (`[{ url }] as const`). A
      // `handler` makes it the opposite: an inbound route config
      // (`fastify.route({ method, url, handler })`).
      if (url && method && !hasProp(node, "handler")) {
        sources.push(this.ds({
          kind: "api-call",
          name: method.toLowerCase(),
          target: url,
          line: node.startPosition.row + 1,
        }));
      }
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
  while (
    n &&
    (n.type === "as_expression" ||
      n.type === "satisfies_expression" ||
      n.type === "parenthesized_expression" ||
      n.type === "non_null_expression")
  ) {
    n = n.namedChild(0);
  }
  if (n && (n.type === "string" || n.type === "template_string")) {
    return stripQuotes(n.text);
  }
  return null;
}

/** Value node of `obj`'s property named `key` (handles bare and quoted keys). */
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
    const list = this.byName.get(name);
    if (!list) return null;
    for (let p: Node | null = at.parent; p; p = p.parent) {
      if (!FUNCTION_SCOPES.has(p.type)) continue;
      let pick: UrlBinding | null = null;
      for (const b of list) if (b.scope === p.id && b.start < at.startIndex) pick = b;
      if (pick) return this.fold(pick);
      if (declaresParam(p, name)) return null;
    }
    // Module scope: a function body runs after the module has initialized, so
    // a module binding declared below its use still counts.
    const mod = list.filter((b) => b.scope === this.root.id);
    const pick = [...mod].reverse().find((b) => b.start < at.startIndex) ?? mod[0];
    return pick ? this.fold(pick) : null;
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

/** Whether a function node declares a parameter of this name. */
function declaresParam(fnNode: Node, name: string): boolean {
  const params = fnNode.childForFieldName("parameters") ?? fnNode.childForFieldName("parameter");
  if (!params) return false;
  if (params.type === "identifier") return params.text === name;
  return new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(params.text);
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
  if (obj.type === "member_expression" && obj.childForFieldName("object")?.type === "this") {
    return obj.childForFieldName("property")?.text ?? null;
  }
  return null;
}

/** Globals an HTTP root may hang off: jQuery's `$.ajax`, `window.fetch`. */
const GLOBAL_RECEIVERS = new Set(["$", "jQuery", "window", "globalThis", "self"]);

/** A receiver named like an HTTP client: `http`, `$http`, `httpClient`, `axios`, `$axios`, `api`, `apiService`, `requests`. */
const HTTP_RECEIVER_RE = /^\$?(http|axios|ky|got|api|request|requests)(client|service)?$/i;

/** Root identifier of a member chain: `apiClient.post` → "apiClient", `a.b.c` → "a". */
function memberRoot(fn: Node): string | null {
  let obj = fn.childForFieldName("object");
  while (obj && obj.type === "member_expression") obj = obj.childForFieldName("object");
  return obj && obj.type === "identifier" ? obj.text : null;
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

/**
 * Whether a verb call is a server-side route/middleware registration
 * (`app.get("/x", handler)`, `router.post(...)`) rather than an outbound call.
 * Signals: the receiver is a known router object, or a handler function is
 * passed as an argument (route handler / middleware).
 */
function isServerRouteDef(fn: Node, callNode: Node): boolean {
  if (fn.type !== "member_expression") return false;
  const objRoot = (fn.childForFieldName("object")?.text ?? "").split(/[.[]/)[0];
  if (SERVER_ROUTER_OBJECTS.has(objRoot)) return true;
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
      if (
        a.type === "arrow_function" ||
        a.type === "function_expression" ||
        a.type === "function"
      ) {
        return true;
      }
    }
  }
  return false;
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
    return trustedRoot || isModelLikeRoot(parts[parts.length - 2]!) ||
      parts.slice(0, -1).some((seg) => ORM_ROOTS.has(seg) || ORM_SEGMENT_RE.test(seg));
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
