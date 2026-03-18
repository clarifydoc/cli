import type { FileAnalysis, LinkInfo, LinkProximity } from "../../types/analysis.js";

/** Lifecycle hooks — calls here run on mount/create → tight (1) */
const LIFECYCLE_HOOKS = new Set([
  // React
  "useEffect", "useLayoutEffect",
  // Vue
  "onMounted", "onBeforeMount", "onServerPrefetch",
  "onActivated",
]);

/** Lifecycle class methods → tight (1) */
const LIFECYCLE_METHODS = new Set([
  "constructor", "componentDidMount", "connectedCallback",
  "ngOnInit", "ngAfterViewInit",
  "mounted", "created", // Vue Options API
]);

/** Watcher/computed/memo hooks — calls here run on state change → medium (2) */
const WATCHER_HOOKS = new Set([
  // React
  "useMemo", "useCallback", "useSelector",
  // Vue
  "watch", "watchEffect", "watchPostEffect", "watchSyncEffect",
  "computed",
]);

/** Update lifecycle class methods → medium (2) */
const UPDATE_METHODS = new Set([
  "componentDidUpdate", "shouldComponentUpdate", "componentWillUpdate",
  "ngOnChanges", "ngDoCheck",
  "updated", // Vue Options API
]);

/**
 * Build a weighted link graph from all file analyses.
 * Each link has a proximity score: 1 (tight), 2 (medium), 3 (loose).
 */
export function buildLinkGraph(analyses: FileAnalysis[]): LinkInfo[] {
  // Collect all cross-file call contexts per file
  const fileCalls: Map<string, CallContext[]> = new Map();

  for (const a of analyses) {
    const contexts: CallContext[] = [];

    // 1. Calls inside dataSources (lifecycle hooks, watchers)
    for (const ds of a.dataSources) {
      for (const call of ds.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getHookProximity(ds.name);
          contexts.push({ callName: call.name, target: call.target, proximity: prox, reason: `${ds.name} callback` });
        }
      }
    }

    // 2. Calls inside functions
    for (const fn of a.functions) {
      for (const call of fn.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getFunctionProximity(fn.name, a);
          contexts.push({ callName: call.name, target: call.target, proximity: prox, reason: `function ${fn.name}` });
        }
      }
    }

    // 3. Calls inside class methods
    for (const cls of a.classes) {
      for (const method of cls.methods) {
        for (const call of method.calls) {
          if (call.kind === "cross-file" && call.target) {
            const prox = getMethodProximity(method.name);
            contexts.push({ callName: call.name, target: call.target, proximity: prox, reason: `${cls.name}.${method.name}` });
          }
        }
      }
    }

    // 4. Calls inside routes (API handler = user-triggered → loose)
    for (const route of a.routes) {
      for (const call of route.calls) {
        if (call.kind === "cross-file" && call.target) {
          contexts.push({ callName: call.name, target: call.target, proximity: 3, reason: `route ${route.httpMethod ?? "USE"} ${route.path}` });
        }
      }
    }

    // 5. Sub-components (rendered on mount → tight)
    for (const comp of a.subComponents) {
      if (comp.importSource) {
        contexts.push({ callName: comp.name, target: comp.importSource, proximity: 1, reason: `renders <${comp.name}>` });
      }
    }

    if (contexts.length > 0) {
      fileCalls.set(a.filePath, contexts);
    }
  }

  // Resolve import source strings to actual file paths
  const filePathMap = buildFilePathMap(analyses);

  // Aggregate into LinkInfo[]
  const links: LinkInfo[] = [];
  const linkMap = new Map<string, { proximity: LinkProximity; reasons: Set<string>; calls: Set<string> }>();

  for (const [sourceFile, contexts] of fileCalls) {
    for (const ctx of contexts) {
      const targetFile = resolveTarget(ctx.target, filePathMap);
      if (!targetFile) continue;

      const key = `${sourceFile}→${targetFile}`;
      const existing = linkMap.get(key);
      if (existing) {
        if (ctx.proximity < existing.proximity) existing.proximity = ctx.proximity;
        existing.reasons.add(ctx.reason);
        existing.calls.add(ctx.callName);
      } else {
        linkMap.set(key, {
          proximity: ctx.proximity,
          reasons: new Set([ctx.reason]),
          calls: new Set([ctx.callName]),
        });
      }
    }
  }

  for (const [key, data] of linkMap) {
    const [source, target] = key.split("→");
    links.push({
      source: source!,
      target: target!,
      proximity: data.proximity,
      reason: [...data.reasons].join("; "),
      calls: [...data.calls],
    });
  }

  return links;
}

interface CallContext {
  callName: string;
  target: string;
  proximity: LinkProximity;
  reason: string;
}

/** Determine proximity based on the lifecycle hook name */
function getHookProximity(hookName: string): LinkProximity {
  if (LIFECYCLE_HOOKS.has(hookName)) return 1;
  if (WATCHER_HOOKS.has(hookName)) return 2;
  return 3;
}

/** Determine proximity based on function name and whether it's an event handler */
function getFunctionProximity(fnName: string, analysis: FileAnalysis): LinkProximity {
  // Check if this function is referenced by an interactive element
  const isEventHandler = analysis.interactiveElements.some(el => el.handler === fnName);
  if (isEventHandler) return 3;

  // Class lifecycle methods
  if (LIFECYCLE_METHODS.has(fnName)) return 1;
  if (UPDATE_METHODS.has(fnName)) return 2;

  // Naming convention: handleXxx, onXxx → event handler → loose
  if (/^handle[A-Z]/.test(fnName) || /^on[A-Z]/.test(fnName)) return 3;

  // Default: loose (can't determine context)
  return 3;
}

/** Determine proximity based on class method name */
function getMethodProximity(methodName: string): LinkProximity {
  if (LIFECYCLE_METHODS.has(methodName)) return 1;
  if (UPDATE_METHODS.has(methodName)) return 2;
  if (/^handle[A-Z]/.test(methodName) || /^on[A-Z]/.test(methodName)) return 3;
  return 3;
}

/** Build a map for resolving import sources to file paths */
function buildFilePathMap(analyses: FileAnalysis[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of analyses) {
    // Store with and without extension for flexible matching
    map.set(a.filePath, a.filePath);
    const base = a.filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|py|java|kt|cs|pas)$/, "");
    map.set(base, a.filePath);
    // Also store without /index suffix
    const noIndex = base.replace(/\/index$/, "");
    if (noIndex !== base) map.set(noIndex, a.filePath);
  }
  return map;
}

/** Resolve an import source (e.g. "./db/users") to an actual file path */
function resolveTarget(importSource: string, filePathMap: Map<string, string>): string | null {
  if (!importSource.startsWith(".")) return null; // skip external packages

  // Try direct match
  const cleaned = importSource.replace(/^\.\//, "");
  for (const [key, filePath] of filePathMap) {
    if (key === cleaned || key.endsWith("/" + cleaned) || key.endsWith(cleaned)) {
      return filePath;
    }
  }
  return null;
}
