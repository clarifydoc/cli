import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../types/analysis.js";
import { DataSourceExtractor } from "./base.js";

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
      const fnName = this.getFunctionName(fn);

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

/** Scan a callback node for meaningful function calls */
function collectCallbackCalls(callbackNode: Node): string[] {
  const calls: string[] = [];
  function walk(n: Node) {
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      if (callee) {
        if (callee.type === "identifier") {
          calls.push(callee.text);
        } else if (callee.type === "member_expression") {
          const method = callee.childForFieldName("property")?.text;
          if (method && !NOISE_METHODS.has(method)) {
            calls.push(callee.text);
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }
  walk(callbackNode);
  return [...new Set(calls)];
}

/** Extract calls from the first callback argument of a call_expression node */
function getCallbackCalls(callNode: Node): string[] {
  const args = callNode.childForFieldName("arguments");
  if (!args) return [];
  for (let i = 0; i < args.childCount; i++) {
    const arg = args.child(i)!;
    if (arg.type === "arrow_function" || arg.type === "function_expression" || arg.type === "function") {
      return collectCallbackCalls(arg);
    }
  }
  return [];
}
