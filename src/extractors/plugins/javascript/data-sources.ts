import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, CallInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/** Named HTTP clients — trusted as API calls without a URL-shape check. */
const HTTP_ROOTS = new Set(["fetch", "axios", "http", "request", "ajax"]);

/**
 * HTTP "verb" methods. These collide with non-HTTP APIs (`Map.get`,
 * `URLSearchParams.get`, `array.includes`), so a verb call is only an API call
 * when its argument is URL-shaped — see `looksLikeUrl`.
 */
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

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

/** ORM root identifiers — when a call starts with one of these, it's a DB op. */
const ORM_ROOTS = new Set([
  "prisma", "db", "client",
  "User", "Users", "Post", "Posts", "Order", "Orders", // generic — caught by DB_METHODS in call-patterns anyway
]);

/** ORM method names that are unambiguously database operations. */
const ORM_METHODS = new Set([
  // Prisma
  "findUnique", "findFirst", "findMany", "create", "createMany",
  "update", "updateMany", "upsert", "delete", "deleteMany", "count", "aggregate", "groupBy",
  // TypeORM / Sequelize / Mongoose
  "findOne", "findAll", "findByPk", "findOrCreate", "save", "remove", "destroy",
  "bulkCreate", "bulkUpdate", "bulkDelete",
  // Drizzle
  "execute", "all", "get", "values", "returning",
  // Knex / query builder
  "insert", "del", "where", "join", "leftJoin", "rightJoin",
]);

/** Method names that are chaining noise, not meaningful calls */
const NOISE_METHODS = new Set([
  "then", "catch", "finally", "json", "text", "blob", "arrayBuffer", "formData",
  "send", "status", "end", "log", "warn", "error", "info",
  "toString", "valueOf", "toJSON",
]);

export class JavaScriptDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
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

      if (fnName) {
        // HTTP call: fetch("/api/x"), axios.get("/api/x"), apiClient.post("/x").
        // Object-config calls (axios({url}), Kubb request({url})) are captured by
        // the request-descriptor `object` branch below.
        const isRoot = isHttpRoot(fnName);
        const isVerb = HTTP_VERBS.has(fnName.toLowerCase());
        // `app.get("/x", handler)` / `router.post(...)` are inbound route
        // definitions (already captured as routes), not outbound calls — exclude.
        if ((isRoot || isVerb) && fn && !isServerRouteDef(fn, node)) {
          const args = node.childForFieldName("arguments");
          const firstArg = args && args.childCount > 1 ? args.child(1) : null;
          if (
            firstArg &&
            (firstArg.type === "string" || firstArg.type === "template_string")
          ) {
            const url = stripQuotes(firstArg.text);
            // Bare HTTP verbs (`get`/`post`/...) collide with `Map.get`,
            // `searchParams.get`, etc., so require a URL-shaped argument; named
            // clients (fetch/axios/http/request) are trusted without it.
            if (isRoot || looksLikeUrl(url)) {
              sources.push(this.ds({
                kind: "api-call",
                name: fnName,
                target: url,
                line: node.startPosition.row + 1,
              }));
            }
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
        if (ormChain && isOrmCall(ormChain)) {
          sources.push(this.ds({
            kind: "database",
            name: ormChain,
            target: null,
            line: node.startPosition.row + 1,
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
      // metadata objects that merely carry a `url` (`[{ url }] as const`).
      if (url && method) {
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
  const leaf = parts[parts.length - 1]!;
  if (ORM_METHODS.has(leaf)) return true;
  if (ORM_ROOTS.has(root) || /Repository$/.test(root)) return true;
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
