import {
  relationForStrategy,
  type FileAnalysis,
  type SymbolLink,
  type SymbolLinkStrategy,
  type CallInfo,
  type Confidence,
  type ParamInfo,
} from "../types/analysis.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import { commonPrefixLength, extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { simpleTypeName } from "../extractors/shared/type-parser.js";
import { isTestFile } from "./test-file-detector.js";
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
    classByProject: buildClassCatalogByProject(analyses),
    leafCatalog: buildLeafCatalog(symbolIndex, projectOf),
    dirTailIndex: buildDirTailIndex(symbolIndex),
    classNameIndex: buildClassNameIndex(symbolIndex),
    projectOf,
    importedFilesCache: new Map(),
    importedStemsCache: new Map(),
  };
  const interfaceImplMap = ctx.interfaceImplMap;
  const links: SymbolLink[] = [];

  // Spec-route joins must never bind a test file (a uniquely-named test
  // helper is not the route's implementation). Built lazily — most repos
  // have no spec-file routes.
  let specTestFiles: Set<string> | null = null;
  const isSpecJoinExcluded = (filePath: string): boolean => {
    if (SPEC_JOIN_CLASS_SUFFIX_RE.test(filePath)) return true;
    specTestFiles ??= new Set(
      analyses.filter((a) => isTestFile(a.filePath, a.language)).map((a) => a.filePath),
    );
    return specTestFiles.has(filePath);
  };

  for (const analysis of analyses) {
    const sourceFile = analysis.filePath;
    // Spec/contract files (OpenAPI, WSDL, GraphQL, JSight) declare an API
    // surface but no executable code. Their routes join to the implementing
    // handler BY NAME (operationId / field / operation), not by resolving a
    // same-repo `Controller#action` handler — so they route through the
    // unique-or-nothing spec join below rather than the generic handler block.
    // Gating on the file's language (not on "has no symbols") is what keeps a
    // symbol-less-but-real route file — a Laravel `routes/web.php` whose
    // `DashboardController#create` handler DOES need the generic resolution —
    // out of the spec join.
    const isSpecFile = SPEC_LANGUAGES.has(analysis.language);

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

      // Link route → its handler method (e.g., route:GET /api/users → getAllUsers).
      // Spec files route through the unique-or-nothing spec join below instead
      // (their `handler` is a spec operationId, not a same-repo symbol), so the
      // generic first-match fallback never binds an operationId to a coincidental
      // same-named symbol.
      if (route.handler && !isSpecFile) {
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
          // Frontend routes: the handler is a COMPONENT defined in another
          // file (`{ path: '/wagesetup', component: WageSetup }` /
          // `<Route element={<ProductList/>}>`) — no same-file symbol exists,
          // so these routes had no trace anchor at all. Resolve through the
          // route's componentPath (lazy `import('./X.vue')`) or the router
          // file's import of the handler name, and anchor at the component's
          // root symbol so the trace continues into its data calls.
          // Try the componentPath (lazy-import module path OR a bare
          // identifier), THEN the import that binds the handler name — a
          // statically-imported component's componentPath is just the
          // identifier, which misses when the file's basename differs in case
          // (component `WageSetup`, file `Wagesetup.vue`); the
          // import's module path is exact.
          const candidateSpecs: string[] = [];
          if (route.componentPath) candidateSpecs.push(route.componentPath);
          const handlerImport = analysis.imports.find(
            (imp) => !imp.isType && imp.specifiers.includes(handlerName),
          );
          if (handlerImport) candidateSpecs.push(handlerImport.source);
          let compFile: string | null = null;
          for (const spec of candidateSpecs) {
            compFile = resolveTarget(spec, sourceFile, ctx.filePathMap);
            if (compFile) break;
          }
          const compSyms = compFile ? symbolIndex.get(compFile) : undefined;
          // Every anchor branch emits the same route→target link shape.
          // (route.handler is narrowed to string by the enclosing if, but the
          // narrowing doesn't survive into a closure — capture it.)
          const callName = route.handler;
          const pushRouteLink = (
            targetFile: string,
            def: { name: string; line: number },
            confidence: Confidence,
            strategy: SymbolLinkStrategy,
          ) => {
            links.push({
              sourceFile,
              sourceSymbol,
              sourceLine: route.line,
              callName,
              targetFile,
              targetSymbol: def.name,
              targetLine: def.line,
              confidence,
              strategy,
              relation: relationForStrategy(strategy),
            });
          };
          let componentLinked = false;
          if (compFile && compSyms) {
            const base = compFile.split("/").pop()!.replace(/\.\w+$/, "");
            // A layout/template-only component may extract NO symbols at all
            // (imports-only script setup) — anchor at a `<component>` pseudo-
            // symbol so the route still deep-links to the component's node in
            // the trace view instead of silently having no handler link.
            const def = compSyms.get(handlerName) ?? compSyms.get("<setup>") ?? compSyms.get(base)
              ?? { name: "<component>", line: 1 };
            pushRouteLink(compFile, def, "EXTRACTED", "route-component");
            componentLinked = true;
          }
          // File-based routing: the route's own file IS the page component
          // (`routes/index/messagecenter.vue` → `/messagecenter`) — anchor at
          // the file's own component root. Gated on a component file
          // extension so a ROUTER-CONFIG route whose component couldn't be
          // resolved never self-anchors to the config file.
          if (!componentLinked && route.kind === "frontend" && /\.(vue|jsx|tsx|svelte)$/.test(sourceFile)) {
            const ownDef = symbolIndex.get(sourceFile)?.get("<setup>") ?? { name: "<component>", line: route.line };
            pushRouteLink(sourceFile, ownDef, "EXTRACTED", "route-self");
            componentLinked = true;
          }
          if (!componentLinked) {
            // Fallback: search all files for the handler name — best-effort, no
            // import proof. Two guards keep it from linking noise (pit-stop: a
            // Laravel `DashboardController#create` bound the first `create`
            // anywhere — a Kotlin DAO; a Kotlin route's `sendMessage` bound a
            // Dart widget): candidates must be in the route file's language
            // family, and a qualified handler's class must be evidenced in the
            // candidate (a same-named symbol or the file's basename).
            const srcFamily = extensionFamily(sourceFile);
            const qualParts = route.handler.split(/[#.]/).filter(Boolean);
            const classPart = qualParts.length > 1 ? qualParts[qualParts.length - 2]! : null;
            for (const [filePath, syms] of symbolIndex) {
              const def = syms.get(handlerName);
              if (!def) continue;
              const tgtFamily = extensionFamily(filePath);
              if (srcFamily && tgtFamily && srcFamily !== tgtFamily) continue;
              if (classPart) {
                const base = filePath.split("/").pop()!.replace(/\.\w+$/, "");
                if (!syms.has(classPart) && !syms.has(`${classPart}.${handlerName}`) && base !== classPart) continue;
              }
              pushRouteLink(filePath, def, "AMBIGUOUS", "route-scan");
              break;
            }
          }
        }
      }

      // Spec-file routes (JSight/OpenAPI/WSDL/GraphQL): the file declares the
      // API surface but contains no code, so there is no same-repo handler
      // symbol. Join by the spec operationId (route.handler) when present, else
      // derive a handler name from the path — unique-or-nothing, no guessing.
      if (route.kind === "api" && isSpecFile) {
        const specLink = specRouteHandlerLink(route, sourceFile, sourceSymbol, ctx, isSpecJoinExcluded);
        if (specLink) links.push(specLink);
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
          strategy: "interface-fanout",
          relation: "implements",
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
  /**
   * The same entry restricted to one language family, when the name is defined
   * in more than one. `isSafeHeuristicTarget` already refuses to bind across
   * families (a JS `new Error()` must not reach a C# `Error`), so counting a
   * cross-family homonym as ambiguity only destroys correct links: in a
   * full-stack repo a TypeScript `interface Owner` would silently block every
   * C# `new Owner()` from resolving. Ambiguity is judged per family.
   */
  byFamily?: Map<string, ClassCatalogEntry>;
}

const CTOR_NAMES = new Set(["constructor", "__init__", "__construct", "New", "new"]);

/**
 * Contract/spec languages whose `api` routes declare the served surface but
 * carry no same-repo handler code — their routes join to the implementing
 * method BY NAME (operationId / GraphQL field / WSDL operation / JSight path).
 */
const SPEC_LANGUAGES: ReadonlySet<string> = new Set(["jsight", "openapi", "graphql", "wsdl"]);

/**
 * Files under test-fixture/sample-data directories define symbols that mimic
 * real APIs by design — heuristic (name-uniqueness) strategies must never link
 * production code into them. Explicit imports still resolve normally.
 */
const TEST_FIXTURE_PATH_RE = /(^|\/)(tests?\/fixtures|__fixtures__|__mocks__|testdata)\//;

/** Test-class basename conventions some language plugins don't declare
 *  (e.g. Kotest `*Spec.kt`) — supplements `isTestFile` for spec-route joins. */
const SPEC_JOIN_CLASS_SUFFIX_RE = /(Test|Tests|Spec|IT)\.\w+$/;

/**
 * Join a spec-file route to its implementing method BY NAME, verb-aware —
 * contract-first backends implement interfaces from an external artifact, so
 * the spec is the only in-repo route statement and no handler symbol exists:
 *   GET /grantable-club-entity-types → getGrantableClubEntityTypes
 *   GET /find-persons                     → findPersons
 * Unique-or-nothing across non-test files; misses stay unlinked (no guess).
 */
function specRouteHandlerLink(
  route: { path: string; httpMethod: string | null; line: number; handler?: string | null },
  sourceFile: string,
  sourceSymbol: string,
  ctx: LinkContext,
  isExcluded: (filePath: string) => boolean,
): SymbolLink | null {
  const segment = route.path.split("/").filter((s) => s && !/[{:}]/.test(s)).pop();
  const words = segment ? segment.split(/[-_]/).filter(Boolean) : [];
  const camel = words.length > 0
    ? words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("")
    : null;
  const pascal = camel ? camel[0]!.toUpperCase() + camel.slice(1) : null;
  const verb = (route.httpMethod ?? "").toLowerCase();
  // The spec operationId (`listUsers`, `UserService.getUser` → leaf `getUser`)
  // is the most precise join key; try it before path-derived candidates. WSDL
  // and OpenAPI carry it verbatim; JSight has none and falls to the path.
  const opId = route.handler
    ? route.handler.includes(".") ? route.handler.split(".").pop()! : route.handler
    : null;
  // A WSDL/SOAP operation is PascalCase (`GetUser`); its C# impl matches
  // verbatim, but the Java (JAX-WS) impl de-capitalizes the first letter
  // (`getUser`) — try both forms of the operationId.
  const opIdLower = opId ? opId[0]!.toLowerCase() + opId.slice(1) : null;
  const candidates = [
    ...(opId ? [opId] : []),
    ...(opIdLower && opIdLower !== opId ? [opIdLower] : []),
    ...(pascal && verb ? [`${verb}${pascal}`] : []),
    ...(camel ? [camel] : []),
  ];
  if (candidates.length === 0) return null;
  for (const cand of candidates) {
    // classNameIndex maps every dot-free symbol name to its defining files in
    // symbolIndex order — same uniqueness semantics as a full scan, O(hits).
    const files = (ctx.classNameIndex.get(cand) ?? []).filter((f) => !isExcluded(f));
    if (files.length !== 1) continue;
    const def = ctx.symbolIndex.get(files[0]!)?.get(cand);
    if (!def) continue;
    return {
      sourceFile,
      sourceSymbol,
      sourceLine: route.line,
      callName: cand,
      targetFile: files[0]!,
      targetSymbol: def.name,
      targetLine: def.line,
      confidence: "INFERRED",
      strategy: "spec-join",
      relation: "calls",
    };
  }
  return null;
}

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
      const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name) || m.name === cls.name);
      const fresh = (): ClassCatalogEntry => ({
        file: a.filePath,
        projectId: a.projectId,
        classLine: cls.line,
        ctorSymbol: ctor ? `${cls.name}.${ctor.name}` : undefined,
        ctorLine: ctor?.line,
        count: 1,
      });
      const family = extensionFamily(a.filePath);
      const existing = map.get(cls.name);

      if (!existing) {
        const entry = fresh();
        if (family) entry.byFamily = new Map([[family, fresh()]]);
        map.set(cls.name, entry);
        continue;
      }

      // Total stays the honest count of definitions; the per-family tally is
      // what ambiguity is judged on, since a target in another family is never
      // eligible anyway.
      existing.count++;
      if (!family) continue;
      existing.byFamily ??= new Map();
      const bucket = existing.byFamily.get(family);
      if (bucket) bucket.count++;
      else existing.byFamily.set(family, fresh());
    }
  }
  return map;
}

/**
 * The catalog entry a call in `sourceFile` should be judged against: the
 * definitions of that name in the caller's own language family. Falls back to
 * the whole entry when the name is defined once, when the caller's family is
 * unknown, or when no definition shares it — in the last case the family guard
 * in `isSafeHeuristicTarget` rejects it anyway, so nothing unsafe gets through.
 */
function classEntryFor(
  entry: ClassCatalogEntry | undefined,
  sourceFile: string,
): ClassCatalogEntry | undefined {
  if (!entry?.byFamily) return entry;
  const family = extensionFamily(sourceFile);
  if (!family) return entry;
  return entry.byFamily.get(family) ?? entry;
}

/** Per-(project, class name) catalog: lets injection resolution disambiguate a
 *  type name that's unique within the caller's project but duplicated elsewhere. */
/** Cap on per-name candidate files kept for closest-dir disambiguation. */
const CLASS_CANDIDATE_CAP = 8;

function buildClassCatalogByProject(
  analyses: FileAnalysis[],
): Map<string, { file: string; count: number; files: string[] }> {
  const map = new Map<string, { file: string; count: number; files: string[] }>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      const key = `${a.projectId}\x00${cls.name}`;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
        // Keep a bounded candidate list — a name defined in a handful of
        // places can still be disambiguated by directory proximity; one
        // defined everywhere (Config, Program) is hopeless either way.
        if (existing.files.length < CLASS_CANDIDATE_CAP) existing.files.push(a.filePath);
      } else {
        map.set(key, { file: a.filePath, count: 1, files: [a.filePath] });
      }
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
  // Strip generic args so a DI field typed `IRepository<Account>` /
  // `IReadOnlyList<Foo>` resolves to its class (`IRepository`) — otherwise the
  // injection map never binds the receiver and `_repository.X` stays unresolved.
  const cleaned = rawType.replace(/<.*$/, "").replace(/[?*&]/g, "").trim();
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
 * Pick the candidate whose file shares the longest leading directory path with
 * `sourceFile` — used to disambiguate a duplicated type name across packages
 * (`app/IAppService` vs `mobileapp/IAppService`) by caller proximity. Returns
 * null on a tie so the caller can fall through instead of guessing.
 */
function closestByDir<T>(items: T[], sourceFile: string, fileOf: (t: T) => string): T | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!;
  const src = sourceFile.split("/").slice(0, -1);
  const score = (f: string): number => {
    const p = f.split("/").slice(0, -1);
    let n = 0;
    while (n < src.length && n < p.length && src[n] === p[n]) n++;
    return n;
  };
  let best: T | null = null;
  let bestScore = -1;
  let tie = false;
  for (const it of items) {
    const s = score(fileOf(it));
    if (s > bestScore) { bestScore = s; best = it; tie = false; }
    else if (s === bestScore) tie = true;
  }
  return tie ? null : best;
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
  opts: { allowCrossProject?: boolean } = {},
): boolean {
  // A name-only heuristic never crosses language families — a JS `new Error()`
  // must not bind a C# `Error` class even when the name is globally unique.
  // Deliberate cross-language joins (QML→C++, webflow→Java) run as dedicated
  // resolvers, not these strategies. Unknown families stay eligible.
  const srcFamily = extensionFamily(sourceFile);
  const tgtFamily = extensionFamily(entry.file);
  return (
    (srcFamily === null || tgtFamily === null || srcFamily === tgtFamily) &&
    entry.count === 1 &&
    entry.file !== sourceFile &&
    // Clean/layered architectures deliberately reference types across sub-projects
    // (Api `new XCommand()` → Application, Application → Domain entities,
    // everyone → Shared). `count === 1` (globally unique name) already guarantees
    // the target is unambiguous, so cross-project resolution is safe to allow for
    // callers that opt in; same-name collisions (count > 1) stay blocked.
    (opts.allowCrossProject || entry.projectId === sourceProjectId) &&
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
  /** `${projectId}\x00${className}` → {file, count} — for same-project uniqueness
   *  when a class name collides ACROSS projects (e.g. a PHP `ApiConnection` and a
   *  Dart `ApiConnection` in different sub-projects). */
  classByProject: Map<string, { file: string; count: number; files: string[] }>;
  leafCatalog: Map<string, LeafCatalogEntry>;
  dirTailIndex: Map<string, string[]>;
  /** Top-level symbol name → files that define it (in symbolIndex order). Lets
   *  Strategy 4 find the class file by O(1) lookup instead of scanning all files. */
  classNameIndex: Map<string, string[]>;
  /** filePath → sub-project id, for project-scoped candidate selection. */
  projectOf: Map<string, string>;
  /** Lazy per-file cache: files this file's imports resolve to (Strategy 4's
   *  cross-project gate). */
  importedFilesCache: Map<string, Set<string>>;
  /** Lazy per-file cache: stems of the files this file's imports resolve to
   *  (Strategy 7's C/C++ header↔impl evidence). */
  importedStemsCache: Map<string, Set<string>>;
}

/** Lowercased basename without extension: `include/User.h` → "user". */
function fileStem(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/** Files the analysis's imports resolve to (cached per source file). */
function importedFilesOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  let set = ctx.importedFilesCache.get(analysis.filePath);
  if (!set) {
    set = new Set();
    for (const imp of analysis.imports) {
      const f = resolveTarget(imp.source, analysis.filePath, ctx.filePathMap);
      if (f && f !== analysis.filePath) set.add(f);
    }
    ctx.importedFilesCache.set(analysis.filePath, set);
  }
  return set;
}

/** Stems of the files the analysis's imports resolve to (cached per source file). */
function importedStemsOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  let set = ctx.importedStemsCache.get(analysis.filePath);
  if (!set) {
    set = new Set();
    for (const f of importedFilesOf(analysis, ctx)) set.add(fileStem(f));
    ctx.importedStemsCache.set(analysis.filePath, set);
  }
  return set;
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
  // Build class → files lookup (ALL definitions — a name can recur across
  // services/features), and a className → ClassInfo lookup for walking base
  // classes (inherited protected DI fields).
  const classToFiles = new Map<string, string[]>();
  const classByName = new Map<string, FileAnalysis["classes"][number]>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      let arr = classToFiles.get(cls.name);
      if (!arr) classToFiles.set(cls.name, (arr = []));
      if (arr.length < CLASS_CANDIDATE_CAP) arr.push(a.filePath);
      if (!classByName.has(cls.name)) classByName.set(cls.name, cls);
    }
  }

  // Resolve a declared type to its defining file. A duplicated class name
  // (microservice repos: a LicenseService per service/feature) picks the
  // definition closest to the CONSUMING file by shared directory prefix —
  // last-writer-wins here silently bound fields to the wrong duplicate and
  // dead-ended every trace through them. Ambiguous ties resolve to nothing.
  const resolveTypeName = (rawType: string, consumerFile: string) => {
    const clean = rawType.replace(/<.*$/, "").replace(/[?*&]/g, "").trim();
    const names = clean.includes(".") ? [clean, clean.split(".").pop()!] : [clean];
    for (const name of names) {
      const files = classToFiles.get(name);
      if (!files || files.length === 0) continue;
      const pick = files.length === 1 ? files[0]! : closestByDir(files, consumerFile, (f) => f);
      if (pick) return { typeName: name, typeFile: pick };
    }
    return null;
  };

  const map = new Map<string, { typeName: string; typeFile: string }>();
  const add = (file: string, name: string, type: string | null, overwrite: boolean): void => {
    if (!type) return;
    const resolved = resolveTypeName(type, file);
    if (!resolved) return;
    const key = `${file}::${name}`;
    if (overwrite || !map.has(key)) {
      map.set(key, resolved);
      map.set(`${file}::this.${name}`, resolved);
    }
  };

  const bareClass = (t: string | null): string =>
    (t ?? "").replace(/<.*$/, "").trim().split(".").pop() ?? "";

  for (const a of analyses) {
    for (const cls of a.classes) {
      // Own constructor params + properties (highest precedence).
      const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name));
      for (const param of ctor?.params ?? []) add(a.filePath, param.name, param.type, true);
      for (const prop of cls.properties) add(a.filePath, prop.name, prop.type, true);

      // Inherited protected DI fields: the CQRS base-handler pattern stores the
      // injected dependency on a base class (`BaseCommandHandler<T,R>` holds
      // `_repository`), so `_repository.X` in a derived handler resolves only if
      // we pull base-class fields down. Walk the extends chain; don't overwrite
      // the derived class's own members.
      const seen = new Set<string>();
      let base = bareClass(cls.extends);
      while (base && classByName.has(base) && !seen.has(base)) {
        seen.add(base);
        const baseCls = classByName.get(base)!;
        for (const prop of baseCls.properties) add(a.filePath, prop.name, prop.type, false);
        base = bareClass(baseCls.extends);
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
  const { filePathMap, symbolIndex, inheritanceMap, injectionMap, interfaceImplMap, classCatalog, classByProject, leafCatalog, classNameIndex } = ctx;

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
    strategy: SymbolLinkStrategy,
  ): SymbolLink => ({
    sourceFile,
    sourceSymbol,
    sourceLine: call.line,
    callName: call.name,
    targetFile: linkTargetFile,
    targetSymbol,
    targetLine,
    confidence,
    strategy,
    relation: relationForStrategy(strategy),
  });

  // Try exact call name first. For unqualified calls, fall back to the leaf name —
  // this resolves cases like route handlers that reference a method by bare name.
  // For qualified calls, we deliberately DON'T fall back to leaf-name lookup here:
  // a qualified call like `_http.PostAsync` should only resolve when the prefix
  // is known (via injection tracking, inheritance, or ClassName.method patterns).
  // Same-file leaf matching for qualified calls causes false self-links.
  let def = fileSymbols.get(call.name);
  // Which strategy found `def`. The default path at the bottom is reached from
  // two places — this plain lookup and Strategy 3's suffix match — and they were
  // previously distinguishable only by `linkConfidence`, which is a different
  // question. Whoever sets `def` sets this.
  let defStrategy: SymbolLinkStrategy = "direct";
  if (!def && !isQualified) {
    def = fileSymbols.get(leafName);
  }
  // `self.foo` / `Self.foo` / `this.foo` — a direct call on the current
  // instance: strip the receiver and look up the leaf in the current file.
  // Restricted to a TWO-segment receiver (`this.foo`, exactly head + leaf): a
  // longer chain like `this.service.foo` is a call THROUGH a field, where `foo`
  // must resolve on the field's type (Strategy 2), NOT on a same-named method of
  // the current class — controllers that delegate to an identically-named
  // service method (`this.service.studentPostStandardDocumentFile`) were
  // self-linking and dead-ending instead of reaching the service.
  if (!def && isQualified && call.kind === "internal" && targetFile === sourceFile && parts.length === 2) {
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
            return mkLink(parentInfo.parentFile, parentDef.name, parentDef.line, "INFERRED", "inheritance");
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
    let enclosingLocals: Array<{ name: string; type: string }> | null = null;
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
        if (param) injection = resolveInjectedType(classCatalog, classByProject, param.type!, sourceFile, analysis.projectId);
      }
      // Local-variable types: `$connection = new ApiConnection(); $connection->request()`
      // — the receiver is a function-local bound to a constructed instance, not a
      // field or param. Resolved from the enclosing function's `localTypes`.
      if (!injection) {
        enclosingLocals ??= findEnclosingLocalTypes(analysis, sourceSymbol);
        const local = enclosingLocals.find((l) => l.name === prefix && l.type);
        if (local) injection = resolveInjectedType(classCatalog, classByProject, local.type, sourceFile, analysis.projectId);
      }
      if (injection) {
        // Skip the interface and link straight to the implementation's method.
        // With a single impl that's unambiguous; with several (a duplicated
        // interface name across packages — e.g. `app/IAppService` vs
        // `mobileapp/IAppService`), pick the impl whose file is closest to the
        // caller (longest shared directory prefix). Ambiguous ties resolve to
        // null and fall through rather than guess.
        const iface = interfaceImplMap.get(injection.typeName);
        if (iface && iface.impls.length >= 1) {
          const candidates = iface.impls.filter(
            (im) => im.methods.has(methodName) || im.methods.has(leafName),
          );
          const impl = candidates.length === 1
            ? candidates[0]!
            : closestByDir(candidates, sourceFile, (im) => im.classFile);
          if (impl) {
            const implMethod = impl.methods.get(methodName) ?? impl.methods.get(leafName);
            if (implMethod) {
              return mkLink(impl.classFile, `${impl.className}.${implMethod.name}`, implMethod.line, "INFERRED", "interface-redirect");
            }
          }
        }

        const typeSymbols = symbolIndex.get(injection.typeFile);
        if (typeSymbols) {
          const injDef = typeSymbols.get(methodName)
            ?? typeSymbols.get(`${injection.typeName}.${methodName}`)
            ?? typeSymbols.get(leafName);
          if (injDef) {
            return mkLink(injection.typeFile, injDef.name, injDef.line, "INFERRED", "injection");
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
          defStrategy = "deep-qualified";
          break;
        }
      }
    }
  }

  // ── Strategy 3b: factory fallback via the binding's provenance ──
  // The member doesn't exist in the target module — the receiver is a
  // library-made object (`const m = useAddLicenseMutation(...)` then
  // `m.mutateAsync(...)`: mutateAsync is tanstack's, not the project's). The
  // classifier recorded WHICH factory made the receiver (CallInfo.via); the
  // factory's definition is where the meaningful project code sits (its
  // mutationFn closure calls the service), so the trace routes through it.
  if (!def && call.kind === "cross-file" && call.via && targetFile) {
    const viaDef = symbolIndex.get(targetFile)?.get(call.via);
    if (viaDef) {
      return mkLink(targetFile, viaDef.name, viaDef.line, "INFERRED", "factory-via");
    }
  }

  // ── Strategy 4: ClassName.method resolution for static/class methods ──
  // For calls like "UserService.find_by_id" — searches all files for the class.
  // Without an explicit import this is at best INFERRED.
  if (!def && isQualified) {
    const className = parts[0]!;
    const methodName = parts.slice(1).join(".");

    // Files defining this class, PROJECT-SCOPED: same-project candidates win
    // (nearest first); a cross-project class is eligible only when this file
    // actually IMPORTS it. Without the gate, `Application.Run` in every
    // Delphi .dpr resolved into an unrelated project's type-library unit that
    // happens to export a class named Application (Word_97.pas collected 68
    // cross-project dependents that way).
    const candidateFiles = classNameIndex.get(className);
    if (candidateFiles) {
      const sameProject = candidateFiles
        .filter((f) => ctx.projectOf.get(f) === analysis.projectId)
        .sort(
          (x, y) =>
            commonPrefixLength(y, sourceFile) - commonPrefixLength(x, sourceFile),
        );
      const eligible =
        sameProject.length === candidateFiles.length
          ? sameProject
          : [
              ...sameProject,
              ...candidateFiles.filter(
                (f) =>
                  ctx.projectOf.get(f) !== analysis.projectId &&
                  importedFilesOf(analysis, ctx).has(f),
              ),
            ];
      for (const filePath of eligible) {
        const syms = symbolIndex.get(filePath)!;
        const classDef = syms.get(`${className}.${methodName}`) ?? syms.get(methodName);
        if (classDef) {
          return mkLink(filePath, classDef.name, classDef.line, "INFERRED", "class-name");
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
      const entry = classEntryFor(classCatalog.get(className), sourceFile);
      // A constructor of a globally-unique type is unambiguous even across
      // sub-projects (`new GetRoleHoldersQuery()` in Api → its record in
      // Application), so allow cross-project resolution here.
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId, { allowCrossProject: true })) {
        return mkLink(
          entry.file,
          entry.ctorSymbol ?? className,
          entry.ctorLine ?? entry.classLine,
          "INFERRED",
          "constructor",
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
          return mkLink(impFile, d.name, d.line, "INFERRED", "import-file");
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
          return mkLink(found.file, found.def.name, found.def.line, "INFERRED", "import-dir");
        }
      }
    }
  }

  // ── Strategy 7: Unique global definition (heuristic) ──
  // Qualified internal call whose receiver type we can't track
  // (`parser.tokenize()`): if exactly one file in the whole project defines the
  // leaf, link it. Uniqueness is the guard — on large projects common names are
  // never unique. Note stdlib-shaped names (ALL_BUILTIN_MEMBERS) never qualify,
  // however unique the app-side definition.
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
        // Receiver-type contradiction veto: when the receiver's DECLARED type
        // is known (typed local / parameter / field) and names neither the
        // candidate's class nor its file, the unique-name match is coincidence
        // — `existing.setStartDate()` on an `Account` local must not bind
        // `CustomerEntity.setStartDate` however unique that setter is. (If the
        // declared type HAD resolved to a file defining the method, Strategy 2
        // would have linked it before reaching here.)
        const declared = receiverDeclaredType(analysis, sourceSymbol, head.replace(/\?$/, ""));
        const tgtClass = entry.def.name.includes(".") ? entry.def.name.split(".")[0]! : null;
        const declEntry = declared ? classEntryFor(classCatalog.get(declared), sourceFile) : undefined;
        const contradicted =
          declared !== null && declared !== tgtClass &&
          !(declEntry && declEntry.count === 1 && declEntry.file === entry.file);

        // Evidence gate: uniqueness alone still magnets every stdlib-shaped
        // leaf in the repo onto the one app definition (`x.stream().toList()`
        // → the sole app-defined `toList`; `ex.getMessage()` → some enum's
        // `getMessage`), poisoning blast radius and the component graph with
        // fully-connected phantom fan-in. Require the target file to be
        // plausibly in scope: imported by this file, or in the same directory
        // (same package/module — needs no import in Java/Kotlin/Go). Files
        // whose imports resolve to nothing local keep the old behavior:
        // import-blind ecosystems (CodeIgniter PHP autoloading) carry no
        // evidence either way, so the gate would only destroy recall there.
        // Same-stem imports count as evidence too: C/C++ includes name
        // `User.h` while the method body lives in `User.cpp`.
        const importedFiles = importedFilesOf(analysis, ctx);
        const sameDir =
          entry.file.slice(0, entry.file.lastIndexOf("/")) ===
          sourceFile.slice(0, sourceFile.lastIndexOf("/"));
        // The disjunction below used to be one condition emitting one link.
        // Its two halves are not equally trustworthy: `evidenced` has a reason
        // to believe the target (same directory, or the file is actually
        // imported), while the import-blind branch has only the absence of
        // contrary evidence. They are split here so the artifact can tell them
        // apart and `lsp:compare` can judge them separately — the weaker branch
        // is the obvious first candidate to drop if it turns out to cost more
        // in conflicts than it earns in recall.
        const evidenced =
          sameDir ||
          importedFiles.has(entry.file) ||
          importedStemsOf(analysis, ctx).has(fileStem(entry.file));
        if (!contradicted && (evidenced || importedFiles.size === 0)) {
          return mkLink(
            entry.file,
            entry.def.name,
            entry.def.line,
            "AMBIGUOUS",
            evidenced ? "unique-global" : "unique-global-blind",
          );
        }
      }
    }
  }

  // ── Strategy 8: Generic type-argument reference ──
  // A call carrying a generic type argument references that type:
  // `_context.Set<Entities.Account>()`, `modelBuilder.Entity<Entities.Account>()`,
  // `mapper.Map<AccountDto>(…)`, `new BulkImportResult<ExternalKey>(…)`. The
  // dependency is on the type argument's definition — exactly what LSP resolves
  // these call sites to. The arg's namespace qualifier (`Entities.Account`)
  // disambiguates same-named types (entity vs. EF-scaffold duplicate) by
  // matching its segments against the candidate file's path.
  if (!def) {
    const tm = call.name.match(/<\s*([A-Za-z_][\w.]*)/);
    if (tm) {
      const arg = tm[1]!;
      const typeName = arg.slice(arg.lastIndexOf(".") + 1);
      const entry = classEntryFor(classCatalog.get(typeName), sourceFile);
      // `count === 1` (globally unique class) is the guard. When several files
      // define the type (a Domain entity AND its EF-scaffold duplicate), the
      // correct binding depends on real type resolution / which `using` is in
      // scope — guessing produces false edges, so leave those to the LSP layer.
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId, { allowCrossProject: true })) {
        return mkLink(entry.file, entry.ctorSymbol ?? typeName, entry.ctorLine ?? entry.classLine, "INFERRED", "type-argument");
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
    strategy: defStrategy,
    relation: relationForStrategy(defStrategy),
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
  return findEnclosingCallable(analysis, sourceSymbol)?.params ?? [];
}

/**
 * DECLARED type of `head` as visible from `sourceSymbol`: a typed local of the
 * enclosing callable, one of its parameters, or a property of the enclosing
 * class. Null when nothing declares it — dynamic receivers stay heuristic.
 */
function receiverDeclaredType(
  analysis: FileAnalysis,
  sourceSymbol: string,
  head: string,
): string | null {
  const callable = findEnclosingCallable(analysis, sourceSymbol);
  if (callable) {
    const local = callable.localTypes?.find((l) => l.name === head);
    if (local) return simpleTypeName(local.type);
    const param = callable.params?.find((p) => p.name === head);
    if (param?.type) return simpleTypeName(param.type);
  }
  const dot = sourceSymbol.indexOf(".");
  if (dot > 0) {
    const cls = analysis.classes.find((c) => c.name === sourceSymbol.slice(0, dot));
    const prop = cls?.properties?.find((p) => p.name === head);
    if (prop?.type) return simpleTypeName(prop.type);
  }
  return null;
}

/** Local `new`-bound variable types of the enclosing function (see FunctionInfo.localTypes). */
function findEnclosingLocalTypes(
  analysis: FileAnalysis,
  sourceSymbol: string,
): Array<{ name: string; type: string }> {
  return findEnclosingCallable(analysis, sourceSymbol)?.localTypes ?? [];
}

/** The FunctionInfo for `sourceSymbol` — a top-level function or a `Class.method`. */
function findEnclosingCallable(
  analysis: FileAnalysis,
  sourceSymbol: string,
): FileAnalysis["functions"][number] | null {
  const fn = analysis.functions.find((f) => f.name === sourceSymbol);
  if (fn) return fn;
  const dot = sourceSymbol.indexOf(".");
  if (dot > 0) {
    const cls = analysis.classes.find((c) => c.name === sourceSymbol.slice(0, dot));
    const method = cls?.methods.find((m) => m.name === sourceSymbol.slice(dot + 1));
    if (method) return method;
  }
  return null;
}

/**
 * Resolve a declared/inferred type name to an injection target — a unique class
 * in the same sub-project, defined in another file. Shared by the param-type and
 * local-`new` resolution paths in Strategy 2.
 */
function resolveInjectedType(
  classCatalog: Map<string, ClassCatalogEntry>,
  classByProject: Map<string, { file: string; count: number; files: string[] }>,
  typeName: string,
  sourceFile: string,
  projectId: string,
): { typeName: string; typeFile: string } | undefined {
  // Strip generics/nullability, and try both the full name and its last dotted
  // segment (FQN / package-qualified types) — same normalization as resolveTypeIn.
  const clean = typeName.replace(/<.*$/, "").replace(/[?*&]/g, "").trim();
  const names = clean.includes(".") ? [clean, clean.split(".").pop()!] : [clean];

  // 1) Same-project uniqueness — handles a name duplicated across sub-projects
  // (the global count would be >1 and block it) while staying unambiguous.
  for (const name of names) {
    const e = classByProject.get(`${projectId}\x00${name}`);
    if (e && e.count === 1 && e.file !== sourceFile) {
      return { typeName: name, typeFile: e.file };
    }
    // 1b) Same name in several places (microservice repos: a LicenseService in
    // License.Application AND in a Wage feature) — pick the definition whose
    // directory is closest to the caller, the same longest-shared-prefix rule
    // that disambiguates duplicated interfaces. Ambiguous ties resolve to
    // nothing rather than guessing.
    if (e && e.count > 1 && e.count <= CLASS_CANDIDATE_CAP) {
      const pick = closestByDir(e.files.filter((f) => f !== sourceFile), sourceFile, (f) => f);
      if (pick) return { typeName: name, typeFile: pick };
    }
  }

  // 2) Globally-unique name (the original guard) — allows resolving to a class in
  // another sub-project when the name is unique everywhere.
  const resolved = resolveTypeIn(classCatalog, typeName);
  const scoped = classEntryFor(resolved?.value, sourceFile);
  if (
    resolved &&
    scoped &&
    scoped.count === 1 &&
    scoped.file !== sourceFile &&
    scoped.projectId === projectId
  ) {
    return { typeName: resolved.name, typeFile: scoped.file };
  }
  return undefined;
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
            strategy: "reference",
            relation: "reference",
          });
        }
      }
    }
  }

  return links;
}
