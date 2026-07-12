import type { FileAnalysis, LinkInfo, LinkProximity, Confidence } from "../../types/analysis.js";
import { posix } from "path";
import { bestConfidence } from "./confidence.js";
// Registry-aggregated data, PUSHED here by the registry (same pattern as
// call-patterns/parser-manager registration): this module is imported by
// plugin code, and plugin metas are imported by the registry, so importing
// the registry from here would close an ESM cycle and TDZ the plugin classes.
// Deliberately null until registered — resolving with partial data would
// silently mis-link, so consumers throw with an actionable message instead.
let externalModulePrefixes: readonly string[] | null = null;
let stripSourceExtensionReSlot: RegExp | null = null;

/** Called once by the registry after aggregating every plugin's data. */
export function registerLinkScoringData(
  prefixes: readonly string[],
  stripRe: RegExp,
): void {
  externalModulePrefixes = prefixes;
  stripSourceExtensionReSlot = stripRe;
}

function requireRegistered<T>(value: T | null): T {
  if (value === null) {
    throw new Error(
      "link-scoring: plugin-aggregated data not registered — import the plugin " +
        'registry ("extractors/registry.js") before building link/path maps',
    );
  }
  return value;
}

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
  const filePathMap = buildFilePathMap(analyses);
  const linkMap = new Map<string, {
    proximity: LinkProximity;
    reasons: Set<string>;
    calls: Set<string>;
    confidence?: Confidence;
  }>();

  function addLink(
    sourceFile: string,
    target: string,
    callName: string,
    proximity: LinkProximity,
    reason: string,
    confidence: Confidence,
  ) {
    const targetFile = resolveTarget(target, sourceFile, filePathMap);
    if (!targetFile || targetFile === sourceFile) return;

    const key = `${sourceFile}\u2192${targetFile}`;
    const existing = linkMap.get(key);
    if (existing) {
      if (proximity < existing.proximity) existing.proximity = proximity;
      existing.reasons.add(reason);
      existing.calls.add(callName);
      existing.confidence = bestConfidence(existing.confidence, confidence);
    } else {
      linkMap.set(key, {
        proximity,
        reasons: new Set([reason]),
        calls: new Set([callName]),
        confidence,
      });
    }
  }

  for (const a of analyses) {
    // 1. ALL imports create links — explicit in source.
    for (const imp of a.imports) {
      if (imp.isType) continue;
      const proximity = getImportProximity(imp.specifiers, a);
      for (const spec of imp.specifiers) {
        addLink(a.filePath, imp.source, spec, proximity, `imports ${spec}`, "EXTRACTED");
      }
    }

    // 2. Cross-file calls inside functions (may refine proximity)
    for (const fn of a.functions) {
      for (const call of fn.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getFunctionProximity(fn.name, a);
          addLink(a.filePath, call.target, call.name, prox, `function ${fn.name}`,
            call.confidence ?? "INFERRED");
        }
      }
    }

    // 3. Cross-file calls inside class methods
    for (const cls of a.classes) {
      for (const method of cls.methods) {
        for (const call of method.calls) {
          if (call.kind === "cross-file" && call.target) {
            const prox = getMethodProximity(method.name);
            addLink(a.filePath, call.target, call.name, prox, `${cls.name}.${method.name}`,
              call.confidence ?? "INFERRED");
          }
        }
      }
    }

    // 4. Cross-file calls inside dataSources (lifecycle hooks, watchers)
    for (const ds of a.dataSources) {
      for (const call of ds.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getHookProximity(ds.name);
          addLink(a.filePath, call.target, call.name, prox, `${ds.name} callback`,
            call.confidence ?? "INFERRED");
        }
      }
    }

    // 5. Route handler calls
    for (const route of a.routes) {
      for (const call of route.calls) {
        if (call.kind === "cross-file" && call.target) {
          addLink(a.filePath, call.target, call.name, 3, `route ${route.httpMethod ?? "USE"} ${route.path}`,
            call.confidence ?? "INFERRED");
        }
      }
    }

    // 6. Sub-components (rendered on mount → tight)
    for (const comp of a.subComponents) {
      if (comp.importSource) {
        addLink(a.filePath, comp.importSource, comp.name, 1, `renders <${comp.name}>`, "EXTRACTED");
      }
    }
  }

  // Convert to LinkInfo[]
  const links: LinkInfo[] = [];
  for (const [key, data] of linkMap) {
    const [source, target] = key.split("\u2192");
    const link: LinkInfo = {
      source: source!,
      target: target!,
      proximity: data.proximity,
      reason: [...data.reasons].join("; "),
      calls: [...data.calls],
    };
    if (data.confidence) link.confidence = data.confidence;
    links.push(link);
  }

  return links;
}

/** Determine proximity based on the lifecycle hook name */
function getHookProximity(hookName: string): LinkProximity {
  if (LIFECYCLE_HOOKS.has(hookName)) return 1;
  if (WATCHER_HOOKS.has(hookName)) return 2;
  return 3;
}

/** Determine proximity based on function name and whether it's an event handler */
function getFunctionProximity(fnName: string, analysis: FileAnalysis): LinkProximity {
  const isEventHandler = analysis.interactiveElements.some(el => el.handler === fnName);
  if (isEventHandler) return 3;
  if (LIFECYCLE_METHODS.has(fnName)) return 1;
  if (UPDATE_METHODS.has(fnName)) return 2;
  if (/^handle[A-Z]/.test(fnName) || /^on[A-Z]/.test(fnName)) return 3;
  return 3;
}

/** Determine proximity based on class method name */
function getMethodProximity(methodName: string): LinkProximity {
  if (LIFECYCLE_METHODS.has(methodName)) return 1;
  if (UPDATE_METHODS.has(methodName)) return 2;
  if (/^handle[A-Z]/.test(methodName) || /^on[A-Z]/.test(methodName)) return 3;
  return 3;
}

/**
 * Determine import proximity based on how the imported symbols are used.
 */
function getImportProximity(specifiers: string[], analysis: FileAnalysis): LinkProximity {
  let best: LinkProximity = 3;

  // Sub-component rendered on mount = tight
  for (const spec of specifiers) {
    if (analysis.subComponents.some(c => c.name === spec)) return 1;
  }

  // Check if specifier is called inside a lifecycle hook
  for (const ds of analysis.dataSources) {
    const hookProx = getHookProximity(ds.name);
    for (const call of ds.calls) {
      if (specifiers.includes(call.name) && hookProx < best) {
        best = hookProx;
      }
    }
  }

  return best;
}

/**
 * Priority of a file for extensionless-key collisions: lower = preferred.
 * Follows MATCH_EXTENSIONS order, which mirrors module-resolution conventions —
 * when `UserForm.tsx` and `UserForm.vue` both exist, an extensionless import
 * `../components/UserForm` means the .tsx (the .vue is imported with its
 * extension spelled out). Unknown extensions sort last.
 */
function extPriority(filePath: string): number {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot) : "";
  const idx = MATCH_EXTENSIONS.indexOf(ext);
  return idx === -1 ? MATCH_EXTENSIONS.length : idx;
}

/** Set key → filePath, resolving collisions by extension priority (ties keep the first). */
function setPreferring(map: Map<string, string>, key: string, filePath: string): void {
  const existing = map.get(key);
  if (existing === undefined || extPriority(filePath) < extPriority(existing)) {
    map.set(key, filePath);
  }
}

/** Build a map for resolving import sources to file paths */
export function buildFilePathMap(analyses: FileAnalysis[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of analyses) {
    map.set(a.filePath, a.filePath);
    const base = a.filePath.replace(requireRegistered(stripSourceExtensionReSlot), "");
    setPreferring(map, base, a.filePath);
    const noIndex = base.replace(/\/index$/, "");
    if (noIndex !== base) setPreferring(map, noIndex, a.filePath);

    // Also map the file's basename (without extension) for package-qualified resolution
    const baseName = base.split("/").pop()!;
    setPreferring(map, baseName, a.filePath);
  }
  return map;
}

/**
 * Memoized resolutions per filePathMap. Resolution is a pure function of
 * (importSource, importer's directory, map contents) and the map is never
 * mutated after buildFilePathMap, so results can be cached for the map's
 * lifetime. The same import string ("react", "./utils") recurs across many
 * files and call sites — caching avoids re-running the fallback chain.
 */
const resolveCache = new WeakMap<Map<string, string>, Map<string, string | null>>();

/**
 * Resolve an import source to an actual file path.
 * Handles:
 *  - Relative: "../hooks/useUsers" → resolved against importer's dir
 *  - Bare unit: "UserModel" → matched against file basenames (Delphi, Pascal)
 *  - Dotted module: "models.user", "services.user_service" → converted to path (Python)
 *  - Package: "com.example.api.service.UserService" → last segment matched (Java/Kotlin)
 */
export function resolveTarget(importSource: string, sourceFile: string, filePathMap: Map<string, string>): string | null {
  let cache = resolveCache.get(filePathMap);
  if (!cache) {
    cache = new Map();
    resolveCache.set(filePathMap, cache);
  }
  // Relative imports resolve against the importer's directory, so the cache
  // key must include it; non-relative resolution is importer-independent.
  const cacheKey = importSource.startsWith(".")
    ? `${posix.dirname(sourceFile)}\u0000${importSource}`
    : importSource;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = resolveTargetUncached(importSource, sourceFile, filePathMap);
  cache.set(cacheKey, result);
  return result;
}

function resolveTargetUncached(importSource: string, sourceFile: string, filePathMap: Map<string, string>): string | null {
  // 1. Relative imports (JS/TS/Python relative)
  if (importSource.startsWith(".")) {
    const sourceDir = posix.dirname(sourceFile);
    const resolved = posix.normalize(posix.join(sourceDir, importSource));
    const match = tryMatch(resolved, filePathMap);
    if (match) return match;
    return null;
  }

  // 2. Skip well-known external packages/standard libraries
  if (isExternalPackage(importSource)) return null;

  // 3. Bare unit name: "UserModel" → try matching against file basenames
  const bareMatch = tryMatch(importSource, filePathMap);
  if (bareMatch) return bareMatch;

  // 4. Dotted module path: "models.user" → "models/user", "services.user_service" → "services/user_service"
  if (importSource.includes(".")) {
    const asPath = importSource.replace(/\./g, "/");
    const dotMatch = tryMatch(asPath, filePathMap);
    if (dotMatch) return dotMatch;

    // Try last segment only: "com.example.api.service.UserService" → "UserService"
    const lastSegment = importSource.split(".").pop()!;
    const segMatch = tryMatch(lastSegment, filePathMap);
    if (segMatch) return segMatch;
  }

  return null;
}

const MATCH_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue", ".py", ".java", ".kt", ".cs", ".pas", ".go", ".rs", ".rb", ".php", ".swift", ".lua", ".scala", ".pl", ".pm", ".vb", ".bas"];

/**
 * Lazily-built index per filePathMap: basename of each map key → first map key
 * with that basename (insertion order, matching what a linear scan over the
 * map would return). Keyed on the map instance; the map is never mutated
 * after buildFilePathMap.
 */
const baseNameIndexCache = new WeakMap<Map<string, string>, Map<string, string>>();

function getBaseNameIndex(filePathMap: Map<string, string>): Map<string, string> {
  let idx = baseNameIndexCache.get(filePathMap);
  if (!idx) {
    idx = new Map();
    for (const key of filePathMap.keys()) {
      const keyBase = key.slice(key.lastIndexOf("/") + 1);
      if (!idx.has(keyBase)) idx.set(keyBase, key);
    }
    baseNameIndexCache.set(filePathMap, idx);
  }
  return idx;
}

/** Try to match a candidate path against the file path map (with extension/index fallbacks) */
function tryMatch(candidate: string, filePathMap: Map<string, string>): string | null {
  // Direct match
  const direct = filePathMap.get(candidate);
  if (direct) return direct;

  // ESM-TS convention: the specifier says `./router.js` (what the COMPILED
  // module will be) while the file on disk is `router.ts`. The map's keys are
  // extension-stripped, so stripping the script extension off the CANDIDATE
  // bridges .js→.ts/.tsx, .mjs→.mts, .cjs→.cts in one step. Restricted to
  // script extensions — stripping `.json`/`.css` could alias a sibling source
  // file that is NOT the import's target.
  const scriptExt = candidate.match(/\.(?:mjs|cjs|jsx|js)$/);
  if (scriptExt) {
    const stripped = filePathMap.get(candidate.slice(0, -scriptExt[0].length));
    if (stripped) return stripped;
  }

  // With common extensions
  for (const ext of MATCH_EXTENSIONS) {
    const withExt = filePathMap.get(candidate + ext);
    if (withExt) return withExt;
  }

  // /index variants
  const withIndex = filePathMap.get(candidate + "/index");
  if (withIndex) return withIndex;

  // Basename match: "UserModel" → find any file whose basename matches
  const baseKey = getBaseNameIndex(filePathMap).get(candidate);
  if (baseKey !== undefined) {
    const byBase = filePathMap.get(baseKey);
    if (byBase) return byBase;
  }

  return null;
}

export function isExternalPackage(source: string): boolean {
  return requireRegistered(externalModulePrefixes).some(prefix =>
    source === prefix || source.startsWith(prefix + ".") || source.startsWith(prefix + "/")
  );
}
