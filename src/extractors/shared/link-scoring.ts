import type { FileAnalysis, LinkInfo, LinkProximity } from "../../types/analysis.js";
import { posix } from "path";

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
  const linkMap = new Map<string, { proximity: LinkProximity; reasons: Set<string>; calls: Set<string> }>();

  function addLink(sourceFile: string, target: string, callName: string, proximity: LinkProximity, reason: string) {
    const targetFile = resolveTarget(target, sourceFile, filePathMap);
    if (!targetFile || targetFile === sourceFile) return;

    const key = `${sourceFile}\u2192${targetFile}`;
    const existing = linkMap.get(key);
    if (existing) {
      if (proximity < existing.proximity) existing.proximity = proximity;
      existing.reasons.add(reason);
      existing.calls.add(callName);
    } else {
      linkMap.set(key, {
        proximity,
        reasons: new Set([reason]),
        calls: new Set([callName]),
      });
    }
  }

  for (const a of analyses) {
    // 1. ALL imports create links (primary link source)
    for (const imp of a.imports) {
      if (imp.isType) continue;
      const proximity = getImportProximity(imp.specifiers, a);
      for (const spec of imp.specifiers) {
        addLink(a.filePath, imp.source, spec, proximity, `imports ${spec}`);
      }
    }

    // 2. Cross-file calls inside functions (may refine proximity)
    for (const fn of a.functions) {
      for (const call of fn.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getFunctionProximity(fn.name, a);
          addLink(a.filePath, call.target, call.name, prox, `function ${fn.name}`);
        }
      }
    }

    // 3. Cross-file calls inside class methods
    for (const cls of a.classes) {
      for (const method of cls.methods) {
        for (const call of method.calls) {
          if (call.kind === "cross-file" && call.target) {
            const prox = getMethodProximity(method.name);
            addLink(a.filePath, call.target, call.name, prox, `${cls.name}.${method.name}`);
          }
        }
      }
    }

    // 4. Cross-file calls inside dataSources (lifecycle hooks, watchers)
    for (const ds of a.dataSources) {
      for (const call of ds.calls) {
        if (call.kind === "cross-file" && call.target) {
          const prox = getHookProximity(ds.name);
          addLink(a.filePath, call.target, call.name, prox, `${ds.name} callback`);
        }
      }
    }

    // 5. Route handler calls
    for (const route of a.routes) {
      for (const call of route.calls) {
        if (call.kind === "cross-file" && call.target) {
          addLink(a.filePath, call.target, call.name, 3, `route ${route.httpMethod ?? "USE"} ${route.path}`);
        }
      }
    }

    // 6. Sub-components (rendered on mount → tight)
    for (const comp of a.subComponents) {
      if (comp.importSource) {
        addLink(a.filePath, comp.importSource, comp.name, 1, `renders <${comp.name}>`);
      }
    }
  }

  // Convert to LinkInfo[]
  const links: LinkInfo[] = [];
  for (const [key, data] of linkMap) {
    const [source, target] = key.split("\u2192");
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

/** Build a map for resolving import sources to file paths */
export function buildFilePathMap(analyses: FileAnalysis[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of analyses) {
    map.set(a.filePath, a.filePath);
    const base = a.filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|py|pyw|java|kt|kts|cs|pas|pp|go|rs|rb|php|swift|lua|scala)$/, "");
    map.set(base, a.filePath);
    const noIndex = base.replace(/\/index$/, "");
    if (noIndex !== base) map.set(noIndex, a.filePath);

    // Also map the file's basename (without extension) for package-qualified resolution
    const baseName = base.split("/").pop()!;
    // Only set if not already mapped (first file wins to avoid ambiguity)
    if (!map.has(baseName)) {
      map.set(baseName, a.filePath);
    }
  }
  return map;
}

/**
 * Resolve an import source to an actual file path.
 * Handles:
 *  - Relative: "../hooks/useUsers" → resolved against importer's dir
 *  - Bare unit: "UserModel" → matched against file basenames (Delphi, Pascal)
 *  - Dotted module: "models.user", "services.user_service" → converted to path (Python)
 *  - Package: "com.example.api.service.UserService" → last segment matched (Java/Kotlin)
 */
export function resolveTarget(importSource: string, sourceFile: string, filePathMap: Map<string, string>): string | null {
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

/** Try to match a candidate path against the file path map (with extension/index fallbacks) */
function tryMatch(candidate: string, filePathMap: Map<string, string>): string | null {
  // Direct match
  const direct = filePathMap.get(candidate);
  if (direct) return direct;

  // With common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".vue", ".py", ".java", ".kt", ".cs", ".pas", ".go", ".rs", ".rb", ".php", ".swift", ".lua", ".scala"]) {
    const withExt = filePathMap.get(candidate + ext);
    if (withExt) return withExt;
  }

  // /index variants
  const withIndex = filePathMap.get(candidate + "/index");
  if (withIndex) return withIndex;

  // Basename match: "UserModel" → find any file whose basename matches
  for (const [key, filePath] of filePathMap) {
    const keyBase = key.split("/").pop()!;
    if (keyBase === candidate) return filePath;
  }

  return null;
}

/** Known external package prefixes to skip — not project files */
const EXTERNAL_PREFIXES = [
  // Delphi/Pascal standard libraries
  "System.", "Vcl.", "Fmx.", "Data.", "Datasnap.", "EMS.", "Winapi.", "Posix.",
  "IdHTTP", "IdTCP", "IdSSL",
  // Java standard libraries
  "java.", "javax.", "jakarta.",
  "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.",
  "io.ktor.", "io.netty.",
  "com.google.", "com.fasterxml.", "com.amazonaws.",
  // Python standard libraries
  "os", "sys", "json", "re", "math", "datetime", "typing", "enum",
  "collections", "itertools", "functools", "pathlib", "hashlib",
  "asyncio", "logging", "unittest", "abc",
  // Python common packages
  "fastapi", "flask", "django", "pydantic", "sqlalchemy",
  "requests", "httpx", "aiohttp", "pytest",
  "numpy", "pandas", "scipy",
  // C# standard
  "System", "Microsoft.", "Newtonsoft.",
  // Go standard library
  "fmt", "net/", "os", "io", "context", "strings", "strconv", "errors", "encoding/",
  "crypto/", "database/", "log", "sync", "time", "testing",
  // Rust standard library + common crates
  "std::", "core::", "alloc::", "serde", "tokio", "actix", "rocket",
  "hyper", "reqwest", "diesel", "sqlx",
  // Ruby standard library + common gems
  "rails", "active_record", "active_support", "action_controller",
  "rspec", "bundler", "rake",
  // PHP standard library + common packages
  "Illuminate\\", "Symfony\\", "Doctrine\\", "Laravel\\",
];

export function isExternalPackage(source: string): boolean {
  return EXTERNAL_PREFIXES.some(prefix =>
    source === prefix || source.startsWith(prefix + ".") || source.startsWith(prefix + "/")
  );
}
