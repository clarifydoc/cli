import type { FileAnalysis, SymbolLink, CallInfo, Confidence, ParamInfo } from "../types/analysis.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import { ALL_BUILTIN_MEMBERS } from "../extractors/registry.js";

interface SymbolDef {
  name: string;
  line: number;
  endLine: number;
}

/**
 * Build a cross-file symbol link table that maps every resolvable call
 * to the function/method definition it targets.
 *
 * Runs as a post-analysis pass after all files have been individually analyzed.
 */
export function buildSymbolLinks(analyses: FileAnalysis[]): SymbolLink[] {
  const symbolIndex = buildSymbolIndex(analyses);
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  const ctx: LinkContext = {
    filePathMap: buildFilePathMap(analyses),
    symbolIndex,
    inheritanceMap: buildInheritanceMap(analyses),
    injectionMap: buildInjectionMap(analyses),
    interfaceImplMap: buildInterfaceImplMap(analyses),
    classCatalog: buildClassCatalog(analyses),
    leafCatalog: buildLeafCatalog(symbolIndex, projectOf),
    dirTailIndex: buildDirTailIndex(symbolIndex),
    classNameIndex: buildClassNameIndex(symbolIndex),
  };
  const interfaceImplMap = ctx.interfaceImplMap;
  const links: SymbolLink[] = [];

  for (const analysis of analyses) {
    const sourceFile = analysis.filePath;

    // Functions
    for (const fn of analysis.functions) {
      for (const call of fn.calls) {
        const link = resolveCallToDefinition(
          sourceFile, fn.name, call, analysis, ctx,
        );
        if (link) links.push(link);
      }
    }

    // Class methods
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        const sourceSymbol = `${cls.name}.${method.name}`;
        for (const call of method.calls) {
          const link = resolveCallToDefinition(
            sourceFile, sourceSymbol, call, analysis, ctx,
          );
          if (link) links.push(link);
        }
      }
    }

    // Route handlers
    for (const route of analysis.routes) {
      const sourceSymbol = `route:${route.httpMethod ?? "USE"} ${route.path}`;

      // Link route → its handler method (e.g., route:GET /api/users → getAllUsers)
      if (route.handler) {
        // Extract the method name from qualified handlers like "h.ListUsers" or "UsersController#index"
        const handlerName = route.handler.includes("#")
          ? route.handler.split("#").pop()!
          : route.handler.includes(".")
            ? route.handler.split(".").pop()!
            : route.handler;

        const handlerLink = resolveCallToDefinition(
          sourceFile, sourceSymbol,
          { name: route.handler, kind: "internal", target: null, line: route.line },
          analysis, ctx,
        );
        if (handlerLink) {
          links.push(handlerLink);
        } else {
          // Fallback: search all files for the handler name — best-effort, no import proof.
          for (const [filePath, syms] of symbolIndex) {
            const def = syms.get(handlerName);
            if (def) {
              links.push({
                sourceFile,
                sourceSymbol,
                sourceLine: route.line,
                callName: route.handler,
                targetFile: filePath,
                targetSymbol: def.name,
                targetLine: def.line,
                confidence: "AMBIGUOUS",
              });
              break;
            }
          }
        }
      }

      // Link route → functions it calls
      for (const call of route.calls) {
        const link = resolveCallToDefinition(
          sourceFile, sourceSymbol, call, analysis, ctx,
        );
        if (link) links.push(link);
      }
    }

    // Data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      for (const call of ds.calls) {
        const link = resolveCallToDefinition(
          sourceFile, ds.name, call, analysis, ctx,
        );
        if (link) links.push(link);
      }
    }
  }

  // Fan-out: for interfaces with >1 implementations, emit a link from each
  // interface method to every implementation's matching method so the trace
  // tab can navigate from interface → all impls. (Single-impl interfaces are
  // already redirected directly at the call site in resolveCallToDefinition.)
  for (const [, info] of interfaceImplMap) {
    if (info.impls.length < 2) continue;
    for (const ifaceMethod of info.methods) {
      const ifaceSymbol = `${info.interfaceName}.${ifaceMethod.name}`;
      for (const impl of info.impls) {
        const implMethod = impl.methods.get(ifaceMethod.name);
        if (!implMethod) continue;
        links.push({
          sourceFile: info.interfaceFile,
          sourceSymbol: ifaceSymbol,
          sourceLine: ifaceMethod.line,
          callName: ifaceMethod.name,
          targetFile: impl.classFile,
          targetSymbol: `${impl.className}.${ifaceMethod.name}`,
          targetLine: implMethod.line,
          confidence: "INFERRED",
          // Navigational only: an interface does not depend on its implementors.
          // Kept for the trace view, excluded from the dependency/cycle graph.
          navigational: true,
        });
      }
    }
  }

  // Phase B: Reverse reference scanning — find which files import each exported symbol
  const reverseLinks = buildReverseReferenceLinks(analyses, ctx.filePathMap, symbolIndex);
  links.push(...reverseLinks);

  // Deduplicate links (same source→target with same call can appear from handler + calls).
  // Keep the highest-confidence entry per key — a directly-extracted match should win
  // over a fallback heuristic that happened to fire first.
  const seen = new Map<string, number>();
  const deduped: SymbolLink[] = [];
  for (const link of links) {
    const key = `${link.sourceFile}::${link.sourceSymbol}::${link.targetFile}::${link.targetSymbol}::${link.callName}`;
    const existingIdx = seen.get(key);
    if (existingIdx === undefined) {
      seen.set(key, deduped.length);
      deduped.push(link);
    } else {
      const existing = deduped[existingIdx]!;
      const existingRank = existing.confidence ? CONFIDENCE_RANK[existing.confidence] : 0;
      const newRank = link.confidence ? CONFIDENCE_RANK[link.confidence] : 0;
      if (newRank > existingRank) deduped[existingIdx] = link;
    }
  }

  return deduped;
}

/**
 * Build a per-file symbol index from all analyses.
 * Maps filePath → Map<symbolName → SymbolDef>
 */
function buildSymbolIndex(
  analyses: FileAnalysis[],
): Map<string, Map<string, SymbolDef>> {
  const index = new Map<string, Map<string, SymbolDef>>();

  for (const analysis of analyses) {
    const fileSymbols = new Map<string, SymbolDef>();

    // Functions
    for (const fn of analysis.functions) {
      fileSymbols.set(fn.name, {
        name: fn.name,
        line: fn.line,
        endLine: fn.endLine,
      });
    }

    // Class methods (store both qualified and unqualified names)
    for (const cls of analysis.classes) {
      // The class itself
      fileSymbols.set(cls.name, {
        name: cls.name,
        line: cls.line,
        endLine: cls.endLine,
      });

      for (const method of cls.methods) {
        const qualified = `${cls.name}.${method.name}`;
        fileSymbols.set(qualified, {
          name: qualified,
          line: method.line,
          endLine: method.endLine,
        });
        // Also store unqualified as fallback (if not already taken by a function)
        if (!fileSymbols.has(method.name)) {
          fileSymbols.set(method.name, {
            name: qualified,
            line: method.line,
            endLine: method.endLine,
          });
        }
      }
    }

    // Exports (fill in symbols not already captured by functions/methods)
    for (const exp of analysis.exports) {
      if (!fileSymbols.has(exp.name)) {
        fileSymbols.set(exp.name, {
          name: exp.name,
          line: exp.line,
          endLine: exp.line,
        });
      }
    }

    index.set(analysis.filePath, fileSymbols);
  }

  return index;
}

interface ClassCatalogEntry {
  file: string;
  projectId: string;
  classLine: number;
  /** Explicit constructor method, when the class declares one. */
  ctorSymbol?: string;
  ctorLine?: number;
  /** How many files define a class with this name (1 = unambiguous). */
  count: number;
}

const CTOR_NAMES = new Set(["constructor", "__init__", "__construct", "New", "new"]);

/**
 * Files under test-fixture/sample-data directories define symbols that mimic
 * real APIs by design — heuristic (name-uniqueness) strategies must never link
 * production code into them. Explicit imports still resolve normally.
 */
const TEST_FIXTURE_PATH_RE = /(^|\/)(tests?\/fixtures|__fixtures__|__mocks__|testdata)\//;

/**
 * Global class-name catalog: className → defining file + constructor.
 * Lets constructor calls (`new User`, VB `UserEditForm(...)`) and typed
 * parameters resolve without an import — same-namespace languages (C#, VB,
 * Java, Go) don't spell one at the call site.
 */
function buildClassCatalog(analyses: FileAnalysis[]): Map<string, ClassCatalogEntry> {
  const map = new Map<string, ClassCatalogEntry>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      const existing = map.get(cls.name);
      if (existing) {
        existing.count++;
        continue;
      }
      const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name) || m.name === cls.name);
      map.set(cls.name, {
        file: a.filePath,
        projectId: a.projectId,
        classLine: cls.line,
        ctorSymbol: ctor ? `${cls.name}.${ctor.name}` : undefined,
        ctorLine: ctor?.line,
        count: 1,
      });
    }
  }
  return map;
}

interface LeafCatalogEntry {
  file: string;
  projectId: string;
  def: SymbolDef;
  /** How many files define this name (1 = unambiguous). */
  count: number;
}

/**
 * Global unqualified-name catalog: symbolName → the single file defining it.
 * Backs the last-resort heuristic for untracked receivers (`processor.run()`):
 * only names defined in exactly one file are linkable, which is what keeps the
 * heuristic safe on large projects — common names are never unique.
 */
function buildLeafCatalog(
  symbolIndex: Map<string, Map<string, SymbolDef>>,
  projectOf: Map<string, string>,
): Map<string, LeafCatalogEntry> {
  const map = new Map<string, LeafCatalogEntry>();
  for (const [filePath, syms] of symbolIndex) {
    for (const [name, def] of syms) {
      if (name.includes(".")) continue;
      const existing = map.get(name);
      if (existing) {
        existing.count++; // Map keys are unique per file, so this is a new file
      } else {
        map.set(name, { file: filePath, projectId: projectOf.get(filePath) ?? "root", def, count: 1 });
      }
    }
  }
  return map;
}

/**
 * Clean a declared type name and resolve it in a name-keyed map: tries the
 * full cleaned name, then the last dot-segment for package-qualified names
 * (`*service.UserService` → `UserService`, Go fields and Java FQNs).
 */
function resolveTypeIn<T>(
  map: Map<string, T>,
  rawType: string,
): { name: string; value: T } | null {
  const cleaned = rawType.replace(/[?*&]/g, "").trim();
  const direct = map.get(cleaned);
  if (direct !== undefined) return { name: cleaned, value: direct };
  if (cleaned.includes(".")) {
    const short = cleaned.split(".").pop()!;
    const byShort = map.get(short);
    if (byShort !== undefined) return { name: short, value: byShort };
  }
  return null;
}

/**
 * Shared guard for the heuristic (global-name) strategies: only link to an
 * unambiguous target in the same sub-project, and never from production code
 * into test-fixture files.
 */
function isSafeHeuristicTarget(
  entry: { file: string; projectId: string; count: number },
  sourceFile: string,
  sourceProjectId: string,
): boolean {
  return (
    entry.count === 1 &&
    entry.file !== sourceFile &&
    entry.projectId === sourceProjectId &&
    !(TEST_FIXTURE_PATH_RE.test(entry.file) && !TEST_FIXTURE_PATH_RE.test(sourceFile))
  );
}

/**
 * Index files by the last segment of their directory (`repository/x.go` →
 * "repository"), so Strategy 6's package-directory match is a lookup instead
 * of an all-files scan per call.
 */
function buildDirTailIndex(
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const filePath of symbolIndex.keys()) {
    const slash = filePath.lastIndexOf("/");
    if (slash === -1) continue; // root files have no package dir
    const dir = filePath.slice(0, slash);
    const tail = dir.slice(dir.lastIndexOf("/") + 1);
    let arr = map.get(tail);
    if (!arr) map.set(tail, (arr = []));
    arr.push(filePath);
  }
  return map;
}

/** Lookup tables built once per buildSymbolLinks run, shared by every call resolution. */
interface LinkContext {
  filePathMap: Map<string, string>;
  symbolIndex: Map<string, Map<string, SymbolDef>>;
  inheritanceMap: Map<string, { parentClass: string; parentFile: string }>;
  injectionMap: Map<string, { typeName: string; typeFile: string }>;
  interfaceImplMap: Map<string, InterfaceImplInfo>;
  classCatalog: Map<string, ClassCatalogEntry>;
  leafCatalog: Map<string, LeafCatalogEntry>;
  dirTailIndex: Map<string, string[]>;
  /** Top-level symbol name → files that define it (in symbolIndex order). Lets
   *  Strategy 4 find the class file by O(1) lookup instead of scanning all files. */
  classNameIndex: Map<string, string[]>;
}

/**
 * Index every top-level (dot-free) symbol name to the files that define it, in
 * symbolIndex iteration order. Strategy 4 (ClassName.method) uses this to locate
 * the defining file without scanning the whole symbolIndex per call — the order
 * is preserved so the same first-match file wins as the old linear scan.
 */
function buildClassNameIndex(
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [filePath, syms] of symbolIndex) {
    for (const name of syms.keys()) {
      if (name.includes(".")) continue; // qualified members aren't class names
      const arr = idx.get(name);
      if (arr) arr.push(filePath);
      else idx.set(name, [filePath]);
    }
  }
  return idx;
}

/**
 * Build an inheritance map: className → { parentClass, parentFile }
 * Used to resolve inherited method calls.
 */
function buildInheritanceMap(
  analyses: FileAnalysis[],
): Map<string, { parentClass: string; parentFile: string }> {
  const classToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      classToFile.set(cls.name, a.filePath);
    }
  }

  const map = new Map<string, { parentClass: string; parentFile: string }>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.extends) {
        const parentFile = classToFile.get(cls.extends);
        if (parentFile) {
          map.set(cls.name, { parentClass: cls.extends, parentFile });
        }
      }
    }
  }
  return map;
}

/**
 * Build a dependency injection map: for each class, track constructor-param
 * types so we can resolve `this.service.method()` calls.
 * Maps: filePath::paramName → { typeName, typeFile }
 */
function buildInjectionMap(
  analyses: FileAnalysis[],
): Map<string, { typeName: string; typeFile: string }> {
  // Build class → file lookup
  const classToFile = new Map<string, string>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      classToFile.set(cls.name, a.filePath);
    }
  }

  // resolveTypeIn returns the SHORT name for qualified types, which is what
  // interfaceImplMap lookups (keyed by class name) need.
  const resolveTypeName = (rawType: string, classToFile: Map<string, string>) => {
    const r = resolveTypeIn(classToFile, rawType);
    return r ? { typeName: r.name, typeFile: r.value } : null;
  };

  const map = new Map<string, { typeName: string; typeFile: string }>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      // Check constructor params for typed dependencies (various language conventions)
      const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name));
      if (ctor) {
        for (const param of ctor.params) {
          if (param.type) {
            const resolved = resolveTypeName(param.type, classToFile);
            if (resolved) {
              // Map both the param name and camelCase variants
              const key = `${a.filePath}::${param.name}`;
              map.set(key, resolved);
              // Also map with "this." prefix for PHP/TS ($this->service, this.service)
              map.set(`${a.filePath}::this.${param.name}`, resolved);
            }
          }
        }
      }

      // Also check class properties with known types
      for (const prop of cls.properties) {
        if (prop.type) {
          const resolved = resolveTypeName(prop.type, classToFile);
          if (resolved) {
            map.set(`${a.filePath}::${prop.name}`, resolved);
            map.set(`${a.filePath}::this.${prop.name}`, resolved);
          }
        }
      }
    }
  }
  return map;
}

/**
 * Build an interface→implementations map keyed by interface name.
 * Used to route calls made through an interface-typed dependency to the
 * concrete implementing class (when there's a single one) or to fan out
 * trace edges from the interface to all implementations (when there are many).
 */
export function buildInterfaceImplMap(
  analyses: FileAnalysis[],
): Map<string, InterfaceImplInfo> {
  const map = new Map<string, InterfaceImplInfo>();

  // Seed entries for every interface we know about.
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") {
        map.set(cls.name, {
          interfaceName: cls.name,
          interfaceFile: a.filePath,
          methods: cls.methods.map((m) => ({ name: m.name, line: m.line })),
          impls: [],
        });
      }
    }
  }

  // Attach implementing classes. Inspect both `implements` and `extends`:
  // some languages (notably C#) can't syntactically distinguish a class base
  // from an interface base, so an interface may appear as `extends` here.
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") continue;
      const candidates = [...cls.implements];
      if (cls.extends) candidates.push(cls.extends);
      for (const ifaceName of candidates) {
        const entry = map.get(ifaceName);
        if (!entry) continue;
        const methods = new Map<string, { name: string; line: number }>();
        for (const m of cls.methods) {
          methods.set(m.name, { name: m.name, line: m.line });
        }
        entry.impls.push({
          className: cls.name,
          classFile: a.filePath,
          methods,
        });
      }
    }
  }

  return map;
}

/**
 * Try to resolve a single call to its definition site.
 * Returns a SymbolLink if resolution succeeds, null otherwise.
 */
export interface InterfaceImplInfo {
  interfaceName: string;
  interfaceFile: string;
  methods: { name: string; line: number }[];
  impls: {
    className: string;
    classFile: string;
    methods: Map<string, { name: string; line: number }>;
  }[];
}

function resolveCallToDefinition(
  sourceFile: string,
  sourceSymbol: string,
  call: CallInfo,
  analysis: FileAnalysis,
  ctx: LinkContext,
): SymbolLink | null {
  const { filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap, classCatalog, leafCatalog, classNameIndex } = ctx;

  // Skip API and database calls — they don't resolve to project symbols
  if (call.kind === "api-call" || call.kind === "database") return null;

  let targetFile: string | null;

  if (call.kind === "cross-file" && call.target) {
    // Resolve import source to actual file path
    targetFile = resolveTarget(call.target, sourceFile, filePathMap);
    if (!targetFile) return null;
  } else if (call.kind === "internal") {
    // Internal calls resolve within the same file
    targetFile = sourceFile;
  } else {
    return null;
  }

  // Look up the symbol in the target file
  const fileSymbols = symbolIndex.get(targetFile);
  if (!fileSymbols) return null;

  // Split once: "userStore.fetchUsers" → head "userStore", leaf "fetchUsers"
  const parts = call.name.split(".");
  const isQualified = parts.length > 1;
  const leafName = parts[parts.length - 1]!;

  const mkLink = (
    linkTargetFile: string,
    targetSymbol: string,
    targetLine: number,
    confidence: Confidence,
  ): SymbolLink => ({
    sourceFile,
    sourceSymbol,
    sourceLine: call.line,
    callName: call.name,
    targetFile: linkTargetFile,
    targetSymbol,
    targetLine,
    confidence,
  });

  // Try exact call name first. For unqualified calls, fall back to the leaf name —
  // this resolves cases like route handlers that reference a method by bare name.
  // For qualified calls, we deliberately DON'T fall back to leaf-name lookup here:
  // a qualified call like `_http.PostAsync` should only resolve when the prefix
  // is known (via injection tracking, inheritance, or ClassName.method patterns).
  // Same-file leaf matching for qualified calls causes false self-links.
  let def = fileSymbols.get(call.name);
  if (!def && !isQualified) {
    def = fileSymbols.get(leafName);
  }
  // `self.foo` / `Self.foo` / `this.foo` — strip the receiver and look up the
  // leaf in the current file. Safe for internal calls because the receiver is
  // unambiguous; for cross-file calls we rely on injection tracking.
  if (!def && isQualified && call.kind === "internal" && targetFile === sourceFile) {
    const head = parts[0]!;
    if (head === "self" || head === "Self" || head === "this") {
      def = fileSymbols.get(leafName);
    }
  }

  // ── Strategy 1: Inheritance resolution ──
  // If not found in current file and call is internal, walk up the class hierarchy.
  // Inherited methods are not explicitly named at the call site — INFERRED.
  if (!def && call.kind === "internal") {
    const currentClasses = analysis.classes;
    for (const cls of currentClasses) {
      let parentInfo = inheritanceMap.get(cls.name);
      const visited = new Set<string>();
      while (parentInfo && !visited.has(parentInfo.parentClass)) {
        visited.add(parentInfo.parentClass);
        const parentSymbols = symbolIndex.get(parentInfo.parentFile);
        if (parentSymbols) {
          const parentDef = parentSymbols.get(leafName)
            ?? parentSymbols.get(`${parentInfo.parentClass}.${leafName}`);
          if (parentDef) {
            return mkLink(parentInfo.parentFile, parentDef.name, parentDef.line, "INFERRED");
          }
        }
        // Walk further up the chain
        parentInfo = inheritanceMap.get(parentInfo.parentClass);
      }
    }
  }

  // ── Strategy 2: Dependency injection resolution ──
  // For qualified calls like "this.authService.authenticate" — resolved via the
  // declared parameter/property type, not via an explicit import of the method.
  if (!def && isQualified) {
    // Lazy: only pay the enclosing-callable scan when the injection map misses.
    let enclosingParams: ParamInfo[] | null = null;
    // Try various prefixes: "this.authService", "authService", "self.service"
    for (let segLen = 1; segLen < parts.length; segLen++) {
      const prefix = parts.slice(0, segLen).join(".");
      const methodName = parts.slice(segLen).join(".");
      const injKey = `${sourceFile}::${prefix}`;
      let injection = injectionMap.get(injKey);
      // Method-parameter types: `request.getEmail()` where the enclosing
      // callable declares `LoginRequest request` — the injection map only
      // covers constructor params and properties, not regular method params.
      if (!injection) {
        enclosingParams ??= findEnclosingCallableParams(analysis, sourceSymbol);
        const param = enclosingParams.find((p) => p.name === prefix && p.type);
        if (param) {
          const resolved = resolveTypeIn(classCatalog, param.type!);
          if (
            resolved &&
            resolved.value.count === 1 &&
            resolved.value.file !== sourceFile &&
            resolved.value.projectId === analysis.projectId
          ) {
            injection = { typeName: resolved.name, typeFile: resolved.value.file };
          }
        }
      }
      if (injection) {
        // If the declared type is an interface with exactly one implementation,
        // skip the interface and link straight to the implementation's method.
        const iface = interfaceImplMap.get(injection.typeName);
        if (iface && iface.impls.length === 1) {
          const impl = iface.impls[0]!;
          const implMethod = impl.methods.get(methodName) ?? impl.methods.get(leafName);
          if (implMethod) {
            return mkLink(impl.classFile, `${impl.className}.${implMethod.name}`, implMethod.line, "INFERRED");
          }
        }

        const typeSymbols = symbolIndex.get(injection.typeFile);
        if (typeSymbols) {
          const injDef = typeSymbols.get(methodName)
            ?? typeSymbols.get(`${injection.typeName}.${methodName}`)
            ?? typeSymbols.get(leafName);
          if (injDef) {
            return mkLink(injection.typeFile, injDef.name, injDef.line, "INFERRED");
          }
        }
      }
    }
  }

  // ── Strategy 3: Deep qualified call resolution ──
  // For calls like "prisma.user.findMany" where "prisma" is imported from another file
  if (!def && call.kind === "cross-file" && isQualified && targetFile) {
    const targetSymbols = symbolIndex.get(targetFile);
    if (targetSymbols) {
      // Try matching any suffix of the qualified name
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join(".");
        const suffixDef = targetSymbols.get(suffix) ?? targetSymbols.get(leafName);
        if (suffixDef) {
          def = suffixDef;
          break;
        }
      }
    }
  }

  // ── Strategy 4: ClassName.method resolution for static/class methods ──
  // For calls like "UserService.find_by_id" — searches all files for the class.
  // Without an explicit import this is at best INFERRED.
  if (!def && isQualified) {
    const className = parts[0]!;
    const methodName = parts.slice(1).join(".");

    // Find which file defines this class — files are pre-indexed by the class
    // name in symbolIndex order, so the first match here is identical to the
    // old full scan but without iterating every file.
    const candidateFiles = classNameIndex.get(className);
    if (candidateFiles) {
      for (const filePath of candidateFiles) {
        const syms = symbolIndex.get(filePath)!;
        const classDef = syms.get(`${className}.${methodName}`) ?? syms.get(methodName);
        if (classDef) {
          return mkLink(filePath, classDef.name, classDef.line, "INFERRED");
        }
      }
    }
  }

  // ── Strategy 5: Constructor resolution ──
  // `new User` (TS/C#/Java), `New User` (VB) — and VB-style bare `UserEditForm(...)`
  // — where the class lives in another file. Same-namespace languages need no
  // import at the call site, so resolve via the (unique) global class name.
  if (!def) {
    const ctorMatch = call.name.match(/^[Nn]ew\s+([\w.]+)$/);
    const className = ctorMatch
      ? ctorMatch[1]!.split(".").pop()!
      : !isQualified
        ? call.name
        : null;
    if (className) {
      const entry = classCatalog.get(className);
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId)) {
        return mkLink(
          entry.file,
          entry.ctorSymbol ?? className,
          entry.ctorLine ?? entry.classLine,
          "INFERRED",
        );
      }
    }
  }

  // ── Strategy 6: Package-qualified call through an imported module ──
  // `repository.NewUserRepository()` (Go): the head is an import alias whose
  // source names a package DIRECTORY rather than a file — find the one file in
  // that package defining the called symbol.
  if (!def && isQualified) {
    const head = parts[0]!;
    const imp = analysis.imports.find((i) => !i.isType && i.specifiers.includes(head));
    if (imp) {
      const impFile = resolveTarget(imp.source, sourceFile, filePathMap);
      if (impFile && impFile !== sourceFile) {
        // Import maps to a single file (TS namespace import, Python module)
        const syms = symbolIndex.get(impFile);
        const d = syms?.get(parts.slice(1).join(".")) ?? syms?.get(leafName);
        if (d) {
          return mkLink(impFile, d.name, d.line, "INFERRED");
        }
      } else if (!impFile) {
        // Import names a directory/package — candidates come from the dir-tail
        // index so this stays a lookup, not an all-files scan per call.
        const tail = imp.source.split("/").pop()!.split(".").pop()!;
        let found: { file: string; def: SymbolDef } | null = null;
        let count = 0;
        for (const filePath of ctx.dirTailIndex.get(tail) ?? []) {
          if (filePath === sourceFile) continue;
          const d = symbolIndex.get(filePath)?.get(leafName);
          if (d) {
            count++;
            if (count > 1) break;
            found = { file: filePath, def: d };
          }
        }
        if (count === 1 && found) {
          return mkLink(found.file, found.def.name, found.def.line, "INFERRED");
        }
      }
    }
  }

  // ── Strategy 7: Unique global definition (heuristic) ──
  // Qualified internal call whose receiver type we can't track (`processor.run()`):
  // if exactly one file in the whole project defines the leaf, link it.
  // Uniqueness is the guard — on large projects common names are never unique.
  if (!def && call.kind === "internal" && isQualified) {
    // Trimmed: multiline chains leave whitespace in extracted call names.
    const head = parts[0]!.trim();
    // Plain identifier receivers only (`processor.run`, `tracker?.done`) — an
    // indexed/call receiver (`signatures[0].getReturnType`) yields an element
    // of unknown type, where a unique-name match is usually coincidence.
    const isPlainReceiver = /^[\w$]+\??$/.test(head);
    if (isPlainReceiver && head !== "this" && head !== "self" && head !== "Self" && !ALL_BUILTIN_MEMBERS.has(leafName)) {
      const entry = leafCatalog.get(leafName);
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId)) {
        return mkLink(entry.file, entry.def.name, entry.def.line, "AMBIGUOUS");
      }
    }
  }

  if (!def) return null;

  // Default path: a definition matched by exact name in the resolved target file.
  // For cross-file calls the confidence inherits from the call's import-side classification;
  // for same-file internal calls the symbol is directly visible — EXTRACTED.
  const linkConfidence: Confidence | undefined =
    call.kind === "cross-file"
      ? call.confidence
      : (call.kind === "internal" ? "EXTRACTED" : undefined);

  const link: SymbolLink = {
    sourceFile,
    sourceSymbol,
    sourceLine: call.line,
    callName: call.name,
    targetFile,
    targetSymbol: def.name,
    targetLine: def.line,
  };
  if (linkConfidence) link.confidence = linkConfidence;
  return link;
}

/**
 * Parameters of the callable a call was made from, identified by sourceSymbol
 * (`fnName` for functions, `Class.method` for methods). Routes and data
 * sources have no declared params — empty.
 */
function findEnclosingCallableParams(analysis: FileAnalysis, sourceSymbol: string): ParamInfo[] {
  const fn = analysis.functions.find((f) => f.name === sourceSymbol);
  if (fn) return fn.params;
  const dot = sourceSymbol.indexOf(".");
  if (dot > 0) {
    const cls = analysis.classes.find((c) => c.name === sourceSymbol.slice(0, dot));
    const method = cls?.methods.find((m) => m.name === sourceSymbol.slice(dot + 1));
    if (method) return method.params;
  }
  return [];
}

/**
 * Build reverse reference links: for each exported symbol, find all files
 * that import it and create a reference link.
 */
function buildReverseReferenceLinks(
  analyses: FileAnalysis[],
  filePathMap: Map<string, string>,
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): SymbolLink[] {
  const links: SymbolLink[] = [];

  // Build import usage: for each file, which specifiers are imported from which sources
  for (const analysis of analyses) {
    for (const imp of analysis.imports) {
      if (imp.isType) continue;

      const targetFile = resolveTarget(imp.source, analysis.filePath, filePathMap);
      if (!targetFile || targetFile === analysis.filePath) continue;

      const targetSymbols = symbolIndex.get(targetFile);
      if (!targetSymbols) continue;

      for (const spec of imp.specifiers) {
        const def = targetSymbols.get(spec);
        if (def) {
          // Reference reverse-link: an explicit import with matching named specifier.
          links.push({
            sourceFile: analysis.filePath,
            sourceSymbol: "(reference)",
            sourceLine: imp.line,
            callName: spec,
            targetFile,
            targetSymbol: def.name,
            targetLine: def.line,
            confidence: "EXTRACTED",
          });
        }
      }
    }
  }

  return links;
}
