import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, CallInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";
import { extractCalls } from "../../shared/call-graph.js";

/** Known fetch/HTTP call patterns */
const API_CALL_NAMES = new Set([
  "fetch", "axios", "http", "request", "ajax",
  "get", "post", "put", "patch", "delete",
]);

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
      const fn = node.childForFieldName("function");
      // For member_expression callees (`prisma.user.findMany`) we need the
      // full dotted chain — the shared getCallName only returns the leaf,
      // which collapses `x.findMany` and bare `findMany()` together and
      // blinds the ORM heuristic to the root identifier.
      const fnName = fn && fn.type === "member_expression" ? fn.text : this.getFunctionName(fn);

      if (fnName) {
        // fetch() or axios.get() etc
        if (isApiCall(fnName)) {
          const args = node.childForFieldName("arguments");
          let target: string | null = null;
          if (args && args.childCount > 1) {
            const firstArg = args.child(1);
            if (
              firstArg &&
              (firstArg.type === "string" || firstArg.type === "template_string")
            ) {
              target = firstArg.text.replace(/^['"`]|['"`]$/g, "");
            }
          }
          sources.push(this.ds({
            kind: "api-call",
            name: fnName,
            target,
            line: node.startPosition.row + 1,
          }));
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
        if (isOrmCall(fnName)) {
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }
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

function isApiCall(name: string): boolean {
  const lower = name.toLowerCase();
  return API_CALL_NAMES.has(lower) || lower.includes("fetch") || lower.includes("http");
}

/**
 * Heuristic: a call is an ORM operation when its leaf method is in ORM_METHODS
 * AND it's a member access (`x.findMany`, not bare `findMany`). The root-name
 * check (`prisma.x.findMany`) is a softer signal that also counts.
 */
function isOrmCall(name: string): boolean {
  if (!name.includes(".")) return false;
  const parts = name.split(".");
  const leaf = parts[parts.length - 1]!;
  if (ORM_METHODS.has(leaf)) return true;
  const root = parts[0]!;
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
