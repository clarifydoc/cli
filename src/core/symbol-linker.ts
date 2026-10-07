import {
  relationForStrategy,
  type ClassInfo,
  type DiBinding,
  type FileAnalysis,
  type Language,
  type SymbolLink,
  type SymbolLinkStrategy,
  type CallInfo,
  type Confidence,
  type ParamInfo,
} from "../types/analysis.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import { commonPrefixLength, extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { isTestFile } from "./test-file-detector.js";
import { ALL_BUILTIN_MEMBERS, BUILTIN_MEMBERS_BY_LANGUAGE, pluginFor } from "../extractors/registry.js";
import { SELF_HEADS, bareSupertypeName, declaredSupertypes, isConstructor, sameTypeSpace } from "./typed-receivers.js";

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
  const memberTypes = buildMemberTypes(analyses);
  const ctx: LinkContext = {
    filePathMap: buildFilePathMap(analyses),
    symbolIndex,
    inheritanceMap: buildInheritanceMap(analyses),
    memberTypes,
    injectionMap: buildInjectionMap(analyses, memberTypes),
    bindings: buildBindingIndex(analyses),
    classAt: buildClassAt(analyses),
    classFiles: buildClassFiles(analyses),
    extensionMethods: buildExtensionMethods(analyses),
    qualifiedDefs: buildQualifiedDefs(symbolIndex, new Map(analyses.map((a) => [a.filePath, a.language as string]))),
    foldedSymbols: new Map(),
    analyses,
    extraLinks: [],
    interfaceImplMap: buildInterfaceImplMap(analyses),
    classCatalog: buildClassCatalog(analyses),
    classByProject: buildClassCatalogByProject(analyses),
    leafCatalog: buildLeafCatalog(symbolIndex, projectOf),
    dirTailIndex: buildDirTailIndex(symbolIndex),
    classNameIndex: buildClassNameIndex(symbolIndex),
    projectOf,
    languageOf: new Map(analyses.map((a) => [a.filePath, a.language as string])),
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
        // A handler named by its class (`BookController.create`, Play's
        // `OrderController.list`) is that class's method or nothing: a
        // same-named method of ANOTHER class, found by name alone, is a
        // different action (a Grails `resources:` mapping names actions the
        // controller may not define). A lowercase qualifier is a variable
        // (`h.ListUsers`) and keeps the name fallback. The owner may be
        // namespaced on the target side (Phoenix's `MyAppWeb.UserController`).
        const owner = /^([A-Z]\w*)\.\w+$/.exec(route.handler)?.[1];
        const targetClass = handlerLink?.targetSymbol.slice(0, Math.max(0, handlerLink.targetSymbol.lastIndexOf(".")));
        const nameOnlyElsewhere =
          handlerLink !== null && owner !== undefined && targetClass !== undefined &&
          (handlerLink.strategy === "unique-global" || handlerLink.strategy === "unique-global-blind") &&
          targetClass !== owner && !targetClass.endsWith("." + owner);
        if (nameOnlyElsewhere) {
          // No link: the route keeps its handler name, unresolved.
        } else if (handlerLink) {
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
          //
          // A componentPath that is a bare identifier the file IMPORTS is
          // decided by that import: the identifier only reaches resolveTarget's
          // fuzzy basename match, which bound `<Route element={<Dashboard />}>`
          // (imported from a missing `./pages/Dashboard`) to an unrelated
          // `Dashboard.vue` elsewhere. A relative import that resolves to no
          // file stops there; a non-relative one (an unresolved alias such as
          // `@/views/Home`) may still fall back to the name.
          const candidateSpecs: string[] = [];
          const isModuleSpec = (s: string) => s.startsWith(".") || s.startsWith("/");
          const bindingName =
            route.componentPath && !isModuleSpec(route.componentPath) ? route.componentPath : handlerName;
          const handlerImport = analysis.imports.find(
            (imp) => !imp.isType && imp.specifiers.includes(bindingName),
          );
          if (route.componentPath && isModuleSpec(route.componentPath)) candidateSpecs.push(route.componentPath);
          if (handlerImport) candidateSpecs.push(handlerImport.source);
          if (route.componentPath && !isModuleSpec(route.componentPath) && !(handlerImport && isModuleSpec(handlerImport.source))) {
            candidateSpecs.push(route.componentPath);
          }
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

  links.push(...ctx.extraLinks);

  // Fan-out: for interfaces with >1 implementations, emit a link from each
  // interface method to every implementation's matching method so the trace
  // tab can navigate from interface → all impls. (Single-impl interfaces are
  // already redirected directly at the call site in resolveCallToDefinition.)
  for (const [, info] of interfaceImplMap) {
    if (info.impls.length < 2) continue;
    for (const ifaceMethod of info.methods) {
      const ifaceSymbol = `${info.interfaceName}.${ifaceMethod.name}`;
      for (const impl of info.impls) {
        // Where the method actually is: the class body, a sibling file of its
        // package (Go), or a base class it inherits from.
        const implMethod = findMethodInClass(ctx, impl.className, impl.classFile, ifaceMethod.name);
        if (!implMethod) continue;
        links.push({
          sourceFile: info.interfaceFile,
          sourceSymbol: ifaceSymbol,
          sourceLine: ifaceMethod.line,
          callName: ifaceMethod.name,
          targetFile: implMethod.file,
          targetSymbol: implMethod.symbol,
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

/** Directories of generated or hand-written test doubles (mockery's `mocks/`, `fakes/`, `stubs/`). */
const TEST_DOUBLE_PATH_RE = /(^|\/)(mocks?|fakes?|stubs?|__mocks__|testdata|tests?\/fixtures)\//;

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
  // A type split across files of one directory (C# partial, Swift extension,
  // Go method stubs, a C++ `.cpp` beside its header) is ONE definition: its
  // parts don't make the name ambiguous. The part declaring a constructor
  // stands for it when the first one seen declares none.
  const partsSeen = new Set<string>();
  for (const a of analyses) {
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    for (const cls of a.classes) {
      const partKey = typesSpanFiles(a.language) ? `${dir}\0${extensionFamily(a.filePath) ?? a.language}\0${cls.name}` : "";
      if (partKey && partsSeen.has(partKey)) {
        const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name) || m.name === cls.name);
        const top = map.get(cls.name);
        for (const e of ctor ? [top, top?.byFamily?.get(extensionFamily(a.filePath) ?? "")] : []) {
          // Only an entry standing for THIS directory's definition, and only
          // when the part seen first declared no constructor.
          if (!e || e.ctorSymbol || e.file.slice(0, e.file.lastIndexOf("/") + 1) !== dir) continue;
          e.file = a.filePath;
          e.classLine = cls.line;
          e.ctorSymbol = `${cls.name}.${ctor!.name}`;
          e.ctorLine = ctor!.line;
        }
        continue;
      }
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
        if (partKey) partsSeen.add(partKey);
        continue;
      }

      // Total stays the honest count of definitions; the per-family tally is
      // what ambiguity is judged on, since a target in another family is never
      // eligible anyway.
      existing.count++;
      if (partKey) partsSeen.add(partKey);
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
  const dirsSeen = new Map<string, Set<string>>();
  for (const a of analyses) {
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    for (const cls of a.classes) {
      const key = `${a.projectId}\x00${cls.name}`;
      const existing = map.get(key);
      let dirs = dirsSeen.get(key);
      if (!dirs) dirsSeen.set(key, (dirs = new Set()));
      // Parts of one type in one directory count once (see buildClassCatalog).
      const newDefinition = !typesSpanFiles(a.language) || !dirs.has(dir);
      dirs.add(dir);
      if (existing) {
        if (newDefinition) existing.count++;
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
export function closestByDir<T>(items: T[], sourceFile: string, fileOf: (t: T) => string): T | null {
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
 * Does `language` split one type across files of a directory (partial
 * classes, extensions, out-of-line methods, Go methods beside their struct —
 * `LanguagePluginManifest.typesSpanFiles`)? Only there are same-named classes
 * of one directory one type; in Python or Java they are different classes.
 */
function typesSpanFiles(language: string | undefined): boolean {
  return !!language && pluginFor(language as Language)?.typesSpanFiles === true;
}

/** Are `language`'s identifiers case-insensitive (VB, Pascal — `caseInsensitiveNames`)? */
function caseInsensitive(language: string | undefined): boolean {
  return !!language && pluginFor(language as Language)?.caseInsensitiveNames === true;
}

/** Does an import put the imported file's top-level functions in scope (`importsShareScope`)? */
function importsShareScope(language: string | undefined): boolean {
  return !!language && pluginFor(language as Language)?.importsShareScope === true;
}

/** A member/method name as `language` compares it. */
function nameKey(language: string | undefined, name: string): string {
  return caseInsensitive(language) ? name.toLowerCase() : name;
}

/**
 * The definition of class `name` among `files`, judged from `nearFile`: the
 * one closest by directory. When the closest are all in ONE directory of a
 * language whose types span files (`typesSpanFiles`) they are one type split
 * across files — a Swift class and its `extension`, a C#
 * partial class, Go method stubs beside their struct — and the richest
 * declaration stands for it (a base class, then the most members, then the
 * path, for determinism); its members and methods are found across the split
 * (`buildMemberTypes` partners, `methodBesideClass`). Otherwise a tie is null.
 */
function pickDefinition(
  name: string,
  files: readonly string[],
  nearFile: string,
  declOf: (file: string, name: string) => ClassInfo | undefined,
  languageOf: (file: string) => string | undefined,
): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0]!;
  const src = nearFile.split("/").slice(0, -1);
  const score = (f: string): number => {
    const p = f.split("/").slice(0, -1);
    let n = 0;
    while (n < src.length && n < p.length && src[n] === p[n]) n++;
    return n;
  };
  let bestScore = -1;
  let best: string[] = [];
  for (const f of files) {
    const sc = score(f);
    if (sc > bestScore) { bestScore = sc; best = [f]; }
    else if (sc === bestScore) best.push(f);
  }
  if (best.length === 1) return best[0]!;
  const dir = (f: string) => f.slice(0, f.lastIndexOf("/") + 1);
  if (new Set(best.map(dir)).size !== 1 || !best.every((f) => typesSpanFiles(languageOf(f)))) return null;
  const rank = (f: string): [number, number, number] => {
    const c = declOf(f, name);
    return [c?.extends ? 1 : 0, c?.properties.length ?? 0, c?.methods.length ?? 0];
  };
  return [...best].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2] || (a < b ? -1 : a > b ? 1 : 0);
  })[0]!;
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
  /** `${file}\0${class}` → member → declared type (own + inherited). */
  memberTypes: Map<string, Map<string, InjectionPoint>>;
  /** File-level flattening of `memberTypes`, for calls outside a class body. */
  injectionMap: Map<string, InjectionPoint>;
  /** DI container registrations by service. */
  bindings: Map<string, IndexedBinding[]>;
  /** `${file}\0${class}` → its ClassInfo (kind, base class). */
  classAt: Map<string, ClassInfo>;
  /** Class name → every file declaring it (capped), for type-space lookups. */
  classFiles: Map<string, string[]>;
  /** `${file}\0${symbol}` of extension methods (a parameter `isReceiver`). */
  extensionMethods: Set<string>;
  /** `Class.method` → files defining it (partial classes, Go methods beside their type); folded for case-insensitive languages. */
  qualifiedDefs: Map<string, string[]>;
  /** Lazy per-file lowercase symbol index for case-insensitive languages. */
  foldedSymbols: Map<string, Map<string, SymbolDef>>;
  analyses: FileAnalysis[];
  /** Lazy: top-level function name → definitions (provider functions in bindings). */
  functionsByName?: Map<string, Array<{ file: string; returnType: string | null }>>;
  /** Lazy: extension method name → definitions with their receiver type. */
  extensions?: Map<string, ExtensionDef[]>;
  /** Lazy: file → its analysis. */
  analysisAt?: Map<string, FileAnalysis>;
  /**
   * Links a resolution produces besides its own: the `reference` edge from a
   * caller to the interface method a redirected/bound call goes through.
   */
  extraLinks: SymbolLink[];
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
  /** filePath → language, for type-space checks on formats without an extension family. */
  languageOf: Map<string, string>;
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
 * What an injected member (constructor param, property, inherited field)
 * declares: its normalized type, the project file defining that type when
 * there is one, and the DI token/key it is injected by.
 */
interface InjectionPoint {
  /** Declared type, normalized by `receiverTypeName` (`Arc<dyn Repo>` → Repo); "" when injected by key alone. */
  typeName: string;
  /** File defining `typeName` — the definition closest to the consumer. Null when it is not a project class. */
  typeFile: string | null;
  /** DI token/key (`@Inject(TOKEN)`, `@Qualifier("x")`). */
  qualifier?: string;
  /** The member's own name (Spring's by-name fallback matches it against bean names). */
  member: string;
  /** The class the member belongs to (contextual bindings key on it). */
  consumer: string;
  /**
   * False for an ordinary method parameter — its value is whatever the caller
   * passes, so container registrations do not decide it. Fields, constructor
   * parameters, container lookups and framework-injected parameters
   * (`ParamInfo.injected` / a qualifier) leave it unset.
   */
  container?: boolean;
}

/**
 * Per-class member types: `${file}\0${class}` → member name → injection
 * point. A class's own constructor params and properties win; fields of base
 * classes are pulled down (the CQRS base-handler pattern stores the injected
 * `_repository` on `BaseCommandHandler<T,R>`), never overwriting.
 */
function buildMemberTypes(analyses: FileAnalysis[]): Map<string, Map<string, InjectionPoint>> {
  // Every definition of a class name (a name can recur across services/features),
  // and the first ClassInfo per name for walking base classes.
  const classToFiles = new Map<string, string[]>();
  const classByName = new Map<string, FileAnalysis["classes"][number]>();
  const declAt = new Map<string, FileAnalysis["classes"][number]>();
  const languageOfFile = new Map(analyses.map((a) => [a.filePath, a.language as string]));
  for (const a of analyses) {
    for (const cls of a.classes) {
      let arr = classToFiles.get(cls.name);
      if (!arr) classToFiles.set(cls.name, (arr = []));
      if (arr.length < CLASS_CANDIDATE_CAP && !arr.includes(a.filePath)) arr.push(a.filePath);
      if (!classByName.has(cls.name)) classByName.set(cls.name, cls);
      declAt.set(memberKey(a.filePath, cls.name), cls);
    }
  }

  // A duplicated class name (microservice repos: a LicenseService per
  // service/feature) resolves to the definition closest to the CONSUMING file
  // by shared directory prefix; ambiguous ties resolve to nothing.
  const fileOf = (typeName: string, consumerFile: string): string | null =>
    pickDefinition(typeName, classToFiles.get(typeName) ?? [], consumerFile, (f, n) => declAt.get(memberKey(f, n)), (f) => languageOfFile.get(f));

  // One type declared across several files of a directory — a Go struct
  // whose methods sit in sibling files (each file carries a stub class with
  // the methods it declares), a C# partial class — shares its members.
  const partners = new Map<string, Array<{ a: FileAnalysis; cls: FileAnalysis["classes"][number] }>>();
  for (const a of analyses) {
    if (!typesSpanFiles(a.language)) continue;
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    for (const cls of a.classes) {
      const key = `${dir}\0${cls.name}`;
      let list = partners.get(key);
      if (!list) partners.set(key, (list = []));
      list.push({ a, cls });
    }
  }

  const out = new Map<string, Map<string, InjectionPoint>>();
  for (const a of analyses) {
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    for (const cls of a.classes) {
      const members = new Map<string, InjectionPoint>();
      const add = (rawName: string, type: string | null, qualifier: string | undefined, overwrite: boolean): void => {
        const name = nameKey(a.language, rawName);
        if (!overwrite && members.has(name)) return;
        const typeName = receiverTypeName(type, a.language);
        // A member injected by key alone (dry-auto_inject `Import["repo"]`,
        // Swift `@Injected(\.repo) var repo`) has no declared type — its
        // registration decides everything.
        if (!typeName && !qualifier) return;
        const point: InjectionPoint = {
          typeName: typeName ?? "",
          typeFile: typeName ? fileOf(typeName, a.filePath) : null,
          member: rawName,
          consumer: cls.name,
        };
        if (qualifier) point.qualifier = qualifier;
        members.set(name, point);
      };
      for (const m of cls.methods) {
        if (!isConstructor(m, cls)) continue;
        for (const p of m.params) add(p.name, p.type, p.qualifier, true);
      }
      for (const prop of cls.properties) add(prop.name, prop.type, prop.qualifier, true);
      for (const partner of partners.get(`${dir}\0${cls.name}`) ?? []) {
        if (partner.cls === cls || partner.a.language !== a.language) continue;
        for (const prop of partner.cls.properties) add(prop.name, prop.type, prop.qualifier, false);
      }

      const seen = new Set<string>([cls.name]);
      let base = bareClassName(cls.extends);
      while (base && classByName.has(base) && !seen.has(base)) {
        seen.add(base);
        const baseCls = classByName.get(base)!;
        for (const prop of baseCls.properties) add(prop.name, prop.type, prop.qualifier, false);
        base = bareClassName(baseCls.extends);
      }
      if (members.size > 0) out.set(memberKey(a.filePath, cls.name), members);
    }
  }
  return out;
}

function memberKey(file: string, className: string): string {
  return `${file}\0${className}`;
}

function bareClassName(t: string | null | undefined): string {
  return (t ?? "").replace(/<.*$/, "").trim().split(".").pop() ?? "";
}

/**
 * File-level injection map, for calls made outside any class body (a
 * top-level function in a file that declares the class): `file::name` and
 * `file::this.name` → the member of whichever class in the file declares it.
 */
function buildInjectionMap(
  analyses: FileAnalysis[],
  memberTypes: Map<string, Map<string, InjectionPoint>>,
): Map<string, InjectionPoint> {
  const map = new Map<string, InjectionPoint>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      const members = memberTypes.get(memberKey(a.filePath, cls.name));
      if (!members) continue;
      for (const [name, point] of members) {
        map.set(`${a.filePath}::${name}`, point);
        map.set(`${a.filePath}::this.${name}`, point);
      }
    }
  }
  return map;
}

/** A `DiBinding` with where it was registered. */
interface IndexedBinding {
  binding: DiBinding;
  file: string;
  projectId: string;
  isTest: boolean;
}

/** Container registrations project-wide, by the service (type or token) they answer. */
function buildBindingIndex(analyses: FileAnalysis[]): Map<string, IndexedBinding[]> {
  const index = new Map<string, IndexedBinding[]>();
  let decls: Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>> | null = null;
  const add = (binding: DiBinding, a: FileAnalysis, isTest: boolean): void => {
    let list = index.get(binding.service);
    if (!list) index.set(binding.service, (list = []));
    list.push({ binding, file: a.filePath, projectId: a.projectId, isTest });
  };
  for (const a of analyses) {
    if (!a.diBindings || a.diBindings.length === 0) continue;
    const isTest = isTestFile(a.filePath, a.language) || TEST_FIXTURE_PATH_RE.test(a.filePath);
    for (const binding of a.diBindings) {
      if (binding.allInterfaces) {
        decls ??= indexClassDecls(analyses);
        for (const service of declaredInterfaces(binding.implementation, a, decls)) add({ ...binding, service }, a, isTest);
        continue;
      }
      add(binding, a, isTest);
    }
  }
  return index;
}

function indexClassDecls(analyses: FileAnalysis[]): Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>> {
  const out = new Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      let list = out.get(cls.name);
      if (!list) out.set(cls.name, (list = []));
      list.push({ a, cls });
    }
  }
  return out;
}

/**
 * The project interfaces class `name` declares, as the registering file `reg`
 * sees it: its definition in the same type space (the registering sub-project
 * first), every part of it when it is split across one directory. A name
 * defined in several places, or a supertype that is not a project interface
 * (a base class, an external `IDisposable`), contributes nothing.
 */
function declaredInterfaces(
  name: string,
  reg: FileAnalysis,
  decls: Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>>,
): string[] {
  const inSpace = (d: { a: FileAnalysis }) => sameTypeSpace(reg.filePath, reg.language, d.a.filePath, d.a.language);
  const cands = (decls.get(name) ?? []).filter(inSpace);
  const own = cands.filter((d) => d.a.projectId === reg.projectId);
  const pool = own.length > 0 ? own : cands;
  if (pool.length === 0 || new Set(pool.map((d) => d.a.filePath.slice(0, d.a.filePath.lastIndexOf("/") + 1))).size !== 1) return [];
  const out = new Set<string>();
  for (const d of pool) {
    for (const sup of declaredSupertypes(d.cls, d.a)) {
      const iface = bareSupertypeName(sup);
      if ((decls.get(iface) ?? []).some((x) => x.cls.kind === "interface" && inSpace(x))) out.add(iface);
    }
  }
  return [...out];
}

/**
 * Build an interface→implementations map, one entry per interface DEFINITION
 * (keyed `${file}\0${name}` — two packages may each define an `IAppService`,
 * and their implementations must not be pooled). Used to route calls made
 * through an interface-typed dependency to the concrete implementing class
 * (when there's a single one) or to fan out trace edges from the interface
 * to all implementations (when there are many). `interfacesNamed` looks
 * entries up by name.
 */
export function buildInterfaceImplMap(
  analyses: FileAnalysis[],
): Map<string, InterfaceImplInfo> {
  const map = new Map<string, InterfaceImplInfo>();

  // Seed entries for every interface we know about.
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") {
        const entry: InterfaceImplInfo = {
          interfaceName: cls.name,
          interfaceFile: a.filePath,
          methods: cls.methods.map((m) => ({ name: m.name, line: m.line, arity: m.params.length })),
          impls: [],
        };
        if (cls.structural) entry.structural = true;
        map.set(memberKey(a.filePath, cls.name), entry);
      }
    }
  }
  const byName = interfacesNamed(map);
  const languageOf = new Map(analyses.map((a) => [a.filePath, a.language as string]));

  // The definition an implementing class means by a name: the only one, or
  // (same type space) the one closest to the implementing file. A tie attaches
  // it nowhere rather than to the wrong interface.
  const definitionFor = (name: string, implFile: string): InterfaceImplInfo | null => {
    const implLang = languageOf.get(implFile) ?? "";
    let defs = (byName.get(name) ?? []).filter((d) =>
      sameTypeSpace(implFile, implLang, d.interfaceFile, languageOf.get(d.interfaceFile) ?? ""),
    );
    if (defs.length <= 1) return defs[0] ?? null;
    // The implementing file's own interface, then one in its own language
    // (a Kotlin class beside a Java interface of the same name means its own).
    const own = defs.find((d) => d.interfaceFile === implFile);
    if (own) return own;
    const sameLang = defs.filter((d) => languageOf.get(d.interfaceFile) === implLang);
    if (sameLang.length > 0) defs = sameLang;
    if (defs.length === 1) return defs[0]!;
    return closestByDir(defs, implFile, (d) => d.interfaceFile);
  };

  // Attach implementing classes. Inspect both `implements` and `extends`:
  // some languages (notably C#) can't syntactically distinguish a class base
  // from an interface base, so an interface may appear as `extends` here.
  const methodsOf = (cls: FileAnalysis["classes"][number]) => {
    const methods = new Map<string, { name: string; line: number }>();
    for (const m of cls.methods) methods.set(m.name, { name: m.name, line: m.line });
    return methods;
  };
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") continue;
      for (const ifaceName of declaredSupertypes(cls, a)) {
        const entry = definitionFor(bareSupertypeName(ifaceName), a.filePath);
        if (!entry) continue;
        entry.impls.push({ className: cls.name, classFile: a.filePath, methods: methodsOf(cls) });
      }
    }
  }

  // A structural interface (every Go interface, a Python Protocol) is never
  // named by the types satisfying it: a type implements it by having every
  // one of its methods. Same type space only, and the interface must declare
  // at least one method (an empty interface is satisfied by everything). A
  // type's method set spans the files of its package (Go methods sit beside
  // their struct in any file of the directory), so it is gathered per
  // directory + name.
  const structuralIfaces = [...map.values()].filter((e) => e.structural && e.methods.length > 0);
  if (structuralIfaces.length > 0) {
    const methodSets = new Map<string, {
      name: string; file: string; methods: Map<string, { name: string; line: number }>; arity: Map<string, number>;
    }>();
    for (const a of analyses) {
      // A type's method set spans its directory only where types span files (Go).
      const scope = typesSpanFiles(a.language) ? a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1) : a.filePath;
      for (const cls of a.classes) {
        if (cls.kind === "interface") continue;
        const key = `${scope}\0${cls.name}`;
        let set = methodSets.get(key);
        if (!set) methodSets.set(key, (set = { name: cls.name, file: a.filePath, methods: new Map(), arity: new Map() }));
        for (const m of cls.methods) {
          if (set.methods.has(m.name)) continue;
          set.methods.set(m.name, { name: m.name, line: m.line });
          set.arity.set(m.name, m.params.length);
        }
      }
    }
    for (const entry of structuralIfaces) {
      const ifaceLang = languageOf.get(entry.interfaceFile) ?? "";
      for (const set of methodSets.values()) {
        if (set.methods.size === 0) continue;
        if (!sameTypeSpace(entry.interfaceFile, ifaceLang, set.file, languageOf.get(set.file) ?? "")) continue;
        // Name AND parameter count: an HTTP handler's `GetByID(c)` is not a
        // repository's `GetByID(ctx, id)`.
        if (!entry.methods.every((m) => set.methods.has(m.name) && (m.arity === undefined || set.arity.get(m.name) === m.arity))) continue;
        if (entry.impls.some((im) => im.className === set.name && im.classFile === set.file)) continue;
        entry.impls.push({ className: set.name, classFile: set.file, methods: set.methods });
      }
    }
  }

  return map;
}

/** Interface definitions grouped by name. */
export function interfacesNamed(map: Map<string, InterfaceImplInfo>): Map<string, InterfaceImplInfo[]> {
  const byName = new Map<string, InterfaceImplInfo[]>();
  for (const entry of map.values()) {
    let list = byName.get(entry.interfaceName);
    if (!list) byName.set(entry.interfaceName, (list = []));
    list.push(entry);
  }
  return byName;
}

/** One interface definition and the classes implementing it. */
export interface InterfaceImplInfo {
  interfaceName: string;
  interfaceFile: string;
  /** Satisfied structurally (see `ClassInfo.structural`). */
  structural?: boolean;
  /** `arity`: declared parameter count, which a structural implementation must match. */
  methods: { name: string; line: number; arity?: number }[];
  impls: {
    className: string;
    classFile: string;
    methods: Map<string, { name: string; line: number }>;
  }[];
}

function buildExtensionMethods(analyses: FileAnalysis[]): Set<string> {
  const out = new Set<string>();
  for (const a of analyses) {
    for (const fn of a.functions) if (fn.params.some((p) => p.isReceiver)) out.add(`${a.filePath}\0${fn.name}`);
    for (const cls of a.classes) {
      for (const m of cls.methods) {
        if (!m.params.some((p) => p.isReceiver)) continue;
        // The symbol index keys a method by both spellings (see buildSymbolIndex).
        out.add(`${a.filePath}\0${cls.name}.${m.name}`);
        out.add(`${a.filePath}\0${m.name}`);
      }
    }
  }
  return out;
}

/** Upper bound on files kept per class name in `classFiles`. */
const CLASS_FILES_CAP = 32;

function buildClassFiles(analyses: FileAnalysis[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      let list = out.get(cls.name);
      if (!list) out.set(cls.name, (list = []));
      if (list.length < CLASS_FILES_CAP && !list.includes(a.filePath)) list.push(a.filePath);
    }
  }
  return out;
}

function buildClassAt(analyses: FileAnalysis[]): Map<string, ClassInfo> {
  const at = new Map<string, ClassInfo>();
  for (const a of analyses) {
    for (const cls of a.classes) at.set(memberKey(a.filePath, cls.name), cls);
  }
  return at;
}

/**
 * Try to resolve a single call to its definition site.
 * Returns a SymbolLink if resolution succeeds, null otherwise.
 */
function resolveCallToDefinition(
  sourceFile: string,
  sourceSymbol: string,
  call: CallInfo,
  analysis: FileAnalysis,
  ctx: LinkContext,
): SymbolLink | null {
  const { filePathMap, symbolIndex, inheritanceMap, classCatalog, leafCatalog, classNameIndex } = ctx;

  // Split once: "userStore.fetchUsers" → head "userStore", leaf "fetchUsers"
  const parts = call.name.split(".");
  const isQualified = parts.length > 1;
  const leafName = parts[parts.length - 1]!;

  const mkLink: MkLink = (
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
  const throughDeclaredType = (): SymbolLink | null =>
    isQualified ? resolveThroughDeclaredType(sourceFile, sourceSymbol, call, analysis, ctx, parts, leafName, mkLink) : null;

  // API and database calls are classified by their NAME (`userRepo.save()`,
  // `apiClient.get()`), which cannot tell an ORM or HTTP client from the
  // project's own class. They reach project code only through a DECLARED
  // receiver: an injected `userRepo` whose class defines `save` makes the call
  // a call into the project, and the access is attributed inside it.
  if (call.kind === "api-call" || call.kind === "database") return throughDeclaredType();

  let targetFile: string | null;

  if (call.kind === "cross-file" && call.target) {
    // Resolve import source to actual file path
    targetFile = resolveTarget(call.target, sourceFile, filePathMap);
    if (!targetFile) return throughDeclaredType();
  } else if (call.kind === "internal") {
    // Internal calls resolve within the same file
    targetFile = sourceFile;
  } else {
    return null;
  }

  // Look up the symbol in the target file
  const fileSymbols = symbolIndex.get(targetFile);
  if (!fileSymbols) return throughDeclaredType();

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
  // Only for a call on the instance itself — `foo()`, `this.foo()`,
  // `super.foo()`: `this.repo.find()` calls the FIELD's `find`, and a base
  // class's own `find` must not capture it (Strategy 2 follows the field).
  const onSelf = !isQualified || (parts.length === 2 && (SELF_HEADS.has(parts[0]!) || SUPER_HEADS.has(parts[0]!.replace(/\(.*\)$/, ""))));
  if (!def && call.kind === "internal" && onSelf) {
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

  // ── Strategy 2: through the receiver's declared type ──
  // `this.authService.authenticate()`, `repo.find()`, `app(Mailer::class)->send()`
  // — resolved via the receiver's declared field/param/local type (and the DI
  // container registrations that bind it), not via an import of the method.
  if (!def && isQualified) {
    const link = throughDeclaredType();
    if (link) return link;
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
  // A stdlib-shaped leaf (`name.startsWith`, `items.includes`) says the
  // receiver is a plain value the factory RETURNED — a string, an array — not
  // a library object standing in for the factory's own code; the factory call
  // is already linked where it is made.
  if (
    !def && call.kind === "cross-file" && call.via && targetFile &&
    !BUILTIN_MEMBERS_BY_LANGUAGE.get(analysis.language)?.has(leafName)
  ) {
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
        // A call on the class itself reaches its class-level method when the
        // language names one apart (Ruby `def self.call` → `X.self.call`).
        const classDef = syms.get(`${className}.self.${methodName}`) ?? syms.get(`${className}.${methodName}`) ?? syms.get(methodName);
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

  // ── Strategy 6b: a bare call into a file whose import shares its scope ──
  // Dot-sourcing / `Import-Module` (PowerShell), `source` (Bash) put the other
  // file's top-level functions in scope without naming them: `Write-Log "x"`
  // after `. ./lib/Common.ps1` is Common's `Write-Log`. Only for languages
  // that say so (`importsShareScope`) — a JS or Python module's names are in
  // scope only when imported by name. Exactly one imported file may define it.
  if (!def && !isQualified && call.kind === "internal" && importsShareScope(analysis.language)) {
    const hits = new Map<string, SymbolDef>();
    for (const imp of analysis.imports) {
      const impFile = resolveTarget(imp.source, sourceFile, filePathMap);
      if (!impFile || impFile === sourceFile || hits.has(impFile)) continue;
      const d = symbolIn(ctx, impFile, call.name);
      if (d && !d.name.includes(".")) hits.set(impFile, d);
    }
    if (hits.size === 1) {
      const [[file, d]] = [...hits];
      return mkLink(file!, d!.name, d!.line, "INFERRED", "import-file");
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
        // An extension method is called on a type that does not declare it
        // (`footer.AddStaticRowElement()` → a static `this BandBase band`
        // method): the receiver's type cannot contradict it.
        const contradicted =
          declared !== null && declared !== tgtClass &&
          !(declEntry && declEntry.count === 1 && declEntry.file === entry.file) &&
          !ctx.extensionMethods.has(`${entry.file}\0${entry.def.name}`);

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

type MkLink = (
  targetFile: string,
  targetSymbol: string,
  targetLine: number,
  confidence: Confidence,
  strategy: SymbolLinkStrategy,
) => SymbolLink;

/** Receiver heads that name the parent class's implementation (`super.foo()`, PHP `parent::foo()`, C# `base.Foo()`). */
const SUPER_HEADS: ReadonlySet<string> = new Set(["super", "parent", "base", "MyBase"]);

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
  const lang = analysis.language;
  const callable = findEnclosingCallable(analysis, sourceSymbol);
  if (callable) {
    const local = callable.localTypes?.find((l) => l.name === head);
    if (local) return receiverTypeName(local.type, lang);
    const param = callable.params?.find((p) => p.name === head);
    if (param?.type) return receiverTypeName(param.type, lang);
  }
  const dot = sourceSymbol.indexOf(".");
  if (dot > 0) {
    const cls = analysis.classes.find((c) => c.name === sourceSymbol.slice(0, dot));
    const prop = cls?.properties?.find((p) => p.name === head);
    if (prop?.type) return receiverTypeName(prop.type, lang);
  }
  return null;
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

/** Longest receiver chain followed through member types (`this.a.b.c.m()`). */
const MAX_RECEIVER_CHAIN = 3;

/**
 * Strategy 2: resolve a qualified call through its receiver's DECLARED type.
 *
 * The receiver is everything before the leaf. Its first segment is looked up
 * the way the language scopes it — a typed local, then a parameter, then a
 * field of the enclosing class (`this.x` / `self.x` go straight to the
 * field); every further segment is a member of the previous segment's class
 * (`s.repo.Find()` on a Go receiver, `this.ctx.users.find()`). A container
 * lookup chained into the call (`app(Mailer::class)->send()`) carries its
 * type on the call itself (`CallInfo.receiverType`).
 *
 * The method part is always exactly the leaf: a receiver whose chain cannot
 * be typed to the end stays unresolved here rather than binding the leaf on
 * some intermediate type.
 */
function resolveThroughDeclaredType(
  sourceFile: string,
  sourceSymbol: string,
  call: CallInfo,
  analysis: FileAnalysis,
  ctx: LinkContext,
  parts: string[],
  leafName: string,
  mkLink: MkLink,
): SymbolLink | null {
  const dot = sourceSymbol.indexOf(".");
  const consumer = dot > 0 && !sourceSymbol.startsWith("route:") ? sourceSymbol.slice(0, dot) : "";
  leafName = receiverSegment(leafName);

  if (call.receiverType || call.receiverQualifier) {
    const typeName = receiverTypeName(call.receiverType, analysis.language);
    if (!typeName && !call.receiverQualifier) return null;
    const point: InjectionPoint = {
      typeName: typeName ?? "",
      typeFile: typeName ? typeFileFor(ctx, typeName, sourceFile, analysis.projectId) : null,
      member: "",
      consumer,
    };
    if (call.receiverQualifier) point.qualifier = call.receiverQualifier;
    return linkThroughPoint(ctx, analysis, sourceFile, point, leafName, mkLink);
  }

  const receiver = parts.slice(0, -1).map(receiverSegment);
  if (receiver.length === 0 || receiver.length > MAX_RECEIVER_CHAIN + 1) return null;

  let point: InjectionPoint | null;
  let rest: string[];
  if (receiver.length >= 2 && SELF_HEADS.has(receiver[0]!)) {
    point = ownMember(ctx, sourceFile, consumer, receiver[1]!);
    rest = receiver.slice(2);
  } else {
    point = scopedName(ctx, analysis, sourceFile, sourceSymbol, consumer, receiver[0]!);
    rest = receiver.slice(1);
  }
  for (const seg of rest) {
    if (!point?.typeFile) return null;
    point = ctx.memberTypes.get(memberKey(point.typeFile, point.typeName))?.get(nameKey(ctx.languageOf.get(point.typeFile), seg)) ?? null;
  }
  if (!point) return null;
  return linkThroughPoint(ctx, analysis, sourceFile, point, leafName, mkLink);
}

/** A field of the enclosing class — or, outside any class, of whichever class in the file declares it. */
function ownMember(ctx: LinkContext, sourceFile: string, consumer: string, name: string): InjectionPoint | null {
  const key = memberKey(sourceFile, consumer);
  const member = nameKey(ctx.languageOf.get(sourceFile), name);
  if (consumer && ctx.classAt.has(key)) return ctx.memberTypes.get(key)?.get(member) ?? null;
  return ctx.injectionMap.get(`${sourceFile}::${member}`) ?? null;
}

/** A bare name as the enclosing callable sees it: local, then parameter, then field. */
function scopedName(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  consumer: string,
  name: string,
): InjectionPoint | null {
  const callable = findEnclosingCallable(analysis, sourceSymbol);
  const key = nameKey(analysis.language, name);
  const local = callable?.localTypes?.find((l) => nameKey(analysis.language, l.name) === key);
  const param = local ? undefined : callable?.params.find((p) => nameKey(analysis.language, p.name) === key);
  const declared = local ?? param;
  if (declared) {
    const typeName = receiverTypeName(declared.type, analysis.language);
    if (!typeName && !declared.qualifier) return null;
    const point: InjectionPoint = {
      typeName: typeName ?? "",
      typeFile: typeName ? typeFileFor(ctx, typeName, sourceFile, analysis.projectId) : null,
      member: name,
      consumer,
    };
    if (declared.qualifier) point.qualifier = declared.qualifier;
    if (param && !param.qualifier && !param.injected) {
      const cls = consumer ? ctx.classAt.get(memberKey(sourceFile, consumer)) : undefined;
      if (!(callable && cls && isConstructor(callable, cls))) point.container = false;
    }
    return point;
  }
  // Where fields need `this.`/`self.`, a bare name is a local or global the
  // body did not type — never the field of the same name.
  if (pluginFor(analysis.language)?.explicitSelfMembers) return null;
  return ownMember(ctx, sourceFile, consumer, name);
}

/**
 * The project file defining class `typeName` as seen from `sourceFile`: the
 * one definition in the caller's sub-project (or the closest of several),
 * else a definition unique across the whole language family. Null when the
 * type is not a project class or is ambiguous.
 */
function typeFileFor(ctx: LinkContext, typeName: string, sourceFile: string, projectId: string): string | null {
  const declOf = (f: string, n: string) => ctx.classAt.get(memberKey(f, n));
  const languageOf = (f: string) => ctx.languageOf.get(f);
  const own = ctx.classByProject.get(`${projectId}\0${typeName}`);
  if (own) {
    const pick = own.files.length === 1 ? own.file : pickDefinition(typeName, own.files, sourceFile, declOf, languageOf);
    if (pick) return pick;
  }
  // Elsewhere in the type space: a unique definition — or one type split
  // across files of a single directory.
  const srcLang = ctx.languageOf.get(sourceFile) ?? "";
  const files = (ctx.classFiles.get(typeName) ?? []).filter((f) =>
    sameTypeSpace(sourceFile, srcLang, f, ctx.languageOf.get(f) ?? ""),
  );
  if (files.length === 1) return files[0]!;
  if (files.length > 1 && new Set(files.map((f) => f.slice(0, f.lastIndexOf("/") + 1))).size === 1) {
    return pickDefinition(typeName, files, sourceFile, declOf, languageOf);
  }
  return null;
}

/**
 * Link a call of `method` on a receiver of the injection point's type:
 *  1. a container registration binding the type (or the point's token) to
 *     one implementation → that implementation's member (`di-binding`);
 *  2. an interface with exactly one implementation → its member
 *     (`interface-redirect`);
 *  3. the declared type's own (or inherited) member (`injection`) — for an
 *     interface with several implementations that is the interface method,
 *     and the navigational fan-out edges reach the implementations.
 */
function linkThroughPoint(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  point: InjectionPoint,
  method: string,
  mkLink: MkLink,
): SymbolLink | null {
  // The caller still depends on the DECLARED type's signature when the call
  // lands on an implementation: record that as a reference edge, so the
  // interface's blast radius keeps its callers.
  const throughDeclared = (link: SymbolLink): SymbolLink => {
    if (point.typeFile && point.typeFile !== link.targetFile && point.typeFile !== sourceFile) {
      // The declared type's member — its own, or inherited from a base
      // interface (`IOrderProducer : IProducer` declares no `ProduceAsync`).
      const declared = findMethodInClass(ctx, point.typeName, point.typeFile, method);
      if (declared && declared.file !== link.targetFile) {
        ctx.extraLinks.push({
          ...link,
          targetFile: declared.file,
          targetSymbol: declared.symbol,
          targetLine: declared.line,
          strategy: "injection",
          relation: "reference",
        });
      }
    }
    return link;
  };

  const bound = boundImplementation(ctx, analysis, sourceFile, point);
  if (bound) {
    const target = findMethodInClass(ctx, bound.className, bound.classFile, method);
    if (target) return throughDeclared(mkLink(target.file, target.symbol, target.line, "INFERRED", "di-binding"));
  }
  if (!point.typeFile) {
    const ext = extensionMethodFor(ctx, analysis, sourceFile, point.typeName, null, method);
    return ext ? mkLink(ext.file, ext.symbol, ext.line, "INFERRED", "injection") : null;
  }

  const iface = ctx.interfaceImplMap.get(memberKey(point.typeFile, point.typeName));
  // Production code never dispatches to a test double (a mockery `mocks/`
  // type, a fake in a test file): only real implementations are counted.
  const sourceIsTest = isTestFile(sourceFile, analysis.language) || TEST_DOUBLE_PATH_RE.test(sourceFile);
  const impls = (iface?.impls ?? []).filter((im) =>
    sourceIsTest || !(TEST_DOUBLE_PATH_RE.test(im.classFile) || isTestFile(im.classFile, (ctx.languageOf.get(im.classFile) ?? analysis.language) as Language)),
  );
  // The one implementation is not the target when it IS the consumer (a
  // decorator holding another instance of its own interface).
  if (impls.length === 1 && impls[0]!.className !== point.consumer) {
    const impl = impls[0]!;
    const target = findMethodInClass(ctx, impl.className, impl.classFile, method);
    if (target) return throughDeclared(mkLink(target.file, target.symbol, target.line, "INFERRED", "interface-redirect"));
  }

  const target = findMethodInClass(ctx, point.typeName, point.typeFile, method);
  if (target) return mkLink(target.file, target.symbol, target.line, "INFERRED", "injection");
  const ext = extensionMethodFor(ctx, analysis, sourceFile, point.typeName, point.typeFile, method);
  if (ext) return mkLink(ext.file, ext.symbol, ext.line, "INFERRED", "injection");
  return null;
}

/** Extension methods by name: their receiver parameter's normalized type. */
interface ExtensionDef {
  file: string;
  symbol: string;
  line: number;
  receiver: string;
  language: string;
}

/**
 * An extension method `method` declared for the receiver's type or one of
 * its base types (C# `static … M(this BandBase b)`, Kotlin `fun Band.m()`),
 * when the type itself declares no such member. Unique-or-nothing.
 */
function extensionMethodFor(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  typeName: string,
  typeFile: string | null,
  method: string,
): { file: string; symbol: string; line: number } | null {
  if (!typeName) return null;
  ctx.extensions ??= buildExtensionIndex(ctx.analyses);
  const defs = (ctx.extensions.get(method) ?? []).filter((d) =>
    sameTypeSpace(sourceFile, analysis.language, d.file, d.language),
  );
  if (defs.length === 0) return null;
  // The type and its declared supertypes, nearest first.
  const types = new Set<string>([typeName]);
  let frontier: Array<{ name: string; file: string }> = typeFile ? [{ name: typeName, file: typeFile }] : [];
  for (let depth = 0; depth < MAX_BASE_DEPTH && frontier.length > 0; depth++) {
    const next: Array<{ name: string; file: string }> = [];
    for (const t of frontier) {
      const cls = ctx.classAt.get(memberKey(t.file, t.name));
      ctx.analysisAt ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
      const owner = ctx.analysisAt.get(t.file);
      if (!cls || !owner) continue;
      for (const sup of declaredSupertypes(cls, owner)) {
        const name = bareSupertypeName(sup);
        if (!name || types.has(name)) continue;
        types.add(name);
        const file = locateClass(ctx, name, t.file, ctx.projectOf.get(t.file) ?? "root");
        if (file) next.push({ name, file });
      }
    }
    frontier = next;
  }
  const hits = defs.filter((d) => types.has(d.receiver));
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  return { file: hit.file, symbol: hit.symbol, line: hit.line };
}

function buildExtensionIndex(analyses: FileAnalysis[]): Map<string, ExtensionDef[]> {
  const out = new Map<string, ExtensionDef[]>();
  const add = (name: string, def: ExtensionDef): void => {
    let list = out.get(name);
    if (!list) out.set(name, (list = []));
    list.push(def);
  };
  for (const a of analyses) {
    const visit = (fn: FileAnalysis["functions"][number], symbol: string): void => {
      const recv = fn.params.find((p) => p.isReceiver);
      const receiver = recv ? receiverTypeName(recv.type, a.language) : null;
      if (receiver) add(fn.name, { file: a.filePath, symbol, line: fn.line, receiver, language: a.language });
    };
    for (const fn of a.functions) visit(fn, fn.name);
    for (const cls of a.classes) for (const m of cls.methods) visit(m, `${cls.name}.${m.name}`);
  }
  return out;
}

/** Deepest base-class chain walked when looking a method up. */
const MAX_BASE_DEPTH = 8;

/** `method` as defined by class `className` in `classFile`, or inherited from its base classes. */
function findMethodInClass(
  ctx: LinkContext,
  className: string,
  classFile: string,
  method: string,
): { file: string; symbol: string; line: number } | null {
  let name = className;
  let file = classFile;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_BASE_DEPTH; depth++) {
    const key = memberKey(file, name);
    if (seen.has(key)) return null;
    seen.add(key);
    const def = symbolIn(ctx, file, `${name}.${method}`);
    if (def) return { file, symbol: def.name, line: def.line };
    const elsewhere = methodBesideClass(ctx, name, file, method);
    if (elsewhere) return elsewhere;
    const promoted = promotedMethod(ctx, name, file, method, seen);
    if (promoted !== undefined) return promoted;
    const base = bareClassName(ctx.classAt.get(key)?.extends ?? baseOfSplitType(ctx, name, file));
    if (!base) return null;
    const baseFile = locateClass(ctx, base, file, ctx.projectOf.get(file) ?? "root");
    if (!baseFile) return null;
    name = base;
    file = baseFile;
  }
  return null;
}

/** A symbol of `file` by name — case-insensitively where the file's language is. */
function symbolIn(ctx: LinkContext, file: string, name: string): SymbolDef | undefined {
  const exact = ctx.symbolIndex.get(file)?.get(name);
  if (exact || !caseInsensitive(ctx.languageOf.get(file))) return exact;
  let folded = ctx.foldedSymbols.get(file);
  if (!folded) {
    folded = new Map();
    for (const [n, d] of ctx.symbolIndex.get(file) ?? []) if (!folded.has(n.toLowerCase())) folded.set(n.toLowerCase(), d);
    ctx.foldedSymbols.set(file, folded);
  }
  return folded.get(name.toLowerCase());
}

/**
 * A method promoted from an EMBEDDED field (Go: a struct embedding `UserRepo`
 * answers `s.Find()` with the embedded value's `Find`) — properties carrying
 * the `embedded` decorator. One embedded path defining it → that method;
 * several → null (Go rejects the ambiguous selector); none → undefined.
 */
function promotedMethod(
  ctx: LinkContext,
  className: string,
  classFile: string,
  method: string,
  seen: Set<string>,
): { file: string; symbol: string; line: number } | null | undefined {
  const embedded = (ctx.classAt.get(memberKey(classFile, className))?.properties ?? []).filter((p) => p.decorators?.includes("embedded"));
  if (embedded.length === 0) return undefined;
  const language = ctx.languageOf.get(classFile);
  const found: Array<{ file: string; symbol: string; line: number }> = [];
  for (const prop of embedded) {
    const typeName = receiverTypeName(prop.type, (language ?? "go") as Language);
    if (!typeName) continue;
    const typeFile = typeFileFor(ctx, typeName, classFile, ctx.projectOf.get(classFile) ?? "root");
    if (!typeFile || seen.has(memberKey(typeFile, typeName))) continue;
    const hit = findMethodInClass(ctx, typeName, typeFile, method);
    if (hit && !found.some((f) => f.file === hit.file && f.symbol === hit.symbol)) found.push(hit);
  }
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0]! : null;
}

/**
 * `Class.method` defined in ANOTHER file than the class declaration, where the
 * language puts it there: a Go method beside its type in the same package
 * directory, a C# partial class's other half (a file that declares the same
 * class in the same sub-project). Unique-or-nothing.
 */
function methodBesideClass(
  ctx: LinkContext,
  className: string,
  classFile: string,
  method: string,
): { file: string; symbol: string; line: number } | null {
  const language = ctx.languageOf.get(classFile);
  if (!typesSpanFiles(language)) return null;
  const qualified = `${className}.${method}`;
  const files = ctx.qualifiedDefs.get(nameKey(language, qualified));
  if (!files) return null;
  const dir = classFile.slice(0, classFile.lastIndexOf("/") + 1);
  const projectId = ctx.projectOf.get(classFile);
  const family = extensionFamily(classFile);
  const hits = files.filter((f) => {
    if (f === classFile || extensionFamily(f) !== family) return false;
    if (f.slice(0, f.lastIndexOf("/") + 1) === dir) return true;
    return ctx.projectOf.get(f) === projectId && ctx.classAt.has(memberKey(f, className));
  });
  if (hits.length !== 1) return null;
  const def = symbolIn(ctx, hits[0]!, qualified);
  return def ? { file: hits[0]!, symbol: def.name, line: def.line } : null;
}

/** The base class another part of a split type (same directory) declares. */
function baseOfSplitType(ctx: LinkContext, className: string, classFile: string): string | null {
  if (!typesSpanFiles(ctx.languageOf.get(classFile))) return null;
  const dir = classFile.slice(0, classFile.lastIndexOf("/") + 1);
  for (const f of ctx.classFiles.get(className) ?? []) {
    if (f === classFile || f.slice(0, f.lastIndexOf("/") + 1) !== dir) continue;
    const ext = ctx.classAt.get(memberKey(f, className))?.extends;
    if (ext) return ext;
  }
  return null;
}

/** Index `Class.method` symbol names to the files defining them. */
function buildQualifiedDefs(
  symbolIndex: Map<string, Map<string, SymbolDef>>,
  languageOf: Map<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, syms] of symbolIndex) {
    const language = languageOf.get(file);
    for (const rawName of syms.keys()) {
      const dot = rawName.indexOf(".");
      if (dot <= 0 || rawName.indexOf(".", dot + 1) !== -1) continue;
      const name = nameKey(language, rawName);
      const list = out.get(name);
      if (list) list.push(file);
      else out.set(name, [file]);
    }
  }
  return out;
}

/**
 * A call-name segment as the receiver it names: `x?` (optional chaining),
 * `x!` / `x!!` (non-null assertions) and line-broken chains all name `x`.
 */
function receiverSegment(seg: string): string {
  return seg.replace(/\s+/g, "").replace(/(?:\?|!+)$/, "");
}

/**
 * The file defining class `name`, judged from `nearFile` (in `projectId`):
 * the one definition in that sub-project (or the closest of several), else a
 * definition unique in the language family.
 */
function locateClass(ctx: LinkContext, name: string, nearFile: string, projectId: string): string | null {
  return typeFileFor(ctx, name, nearFile, projectId);
}

/** Longest alias chain followed through bindings (`useExisting`, a binding to another bound interface). */
const MAX_BINDING_HOPS = 4;

/**
 * The implementation a DI container injects for this point, when its
 * registrations decide it. Production code never sees a test container's
 * registrations; a contextual registration for the consuming class beats a
 * general one; the caller's own sub-project's container beats the others.
 * What is left must name ONE implementation — or one `primary`, or (when the
 * container autowires by name) one whose qualifier is the member's name.
 * Anything else is a decision the source does not make statically (two
 * unconditional registrations, environment switches) and resolves to null.
 */
function boundImplementation(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  point: InjectionPoint,
): { className: string; classFile: string } | null {
  if (ctx.bindings.size === 0 || point.container === false) return null;
  const sourceIsTest = isTestFile(sourceFile, analysis.language);
  // Where a registration's implementation class is, as its registering file
  // sees it — two classes both named `AppService` are two implementations.
  const located = new Map<IndexedBinding, string | null>();
  const implFile = (c: IndexedBinding): string | null => {
    if (!located.has(c)) located.set(c, locateClass(ctx, c.binding.implementation, c.file, c.projectId));
    return located.get(c)!;
  };

  let service = point.qualifier && ctx.bindings.has(point.qualifier) ? point.qualifier : point.typeName;
  if (!service) return null;
  let byToken = service !== point.typeName;
  let member = point.member;
  let consumer = point.consumer;
  let serviceFile = byToken ? null : point.typeFile;
  for (let hop = 0; hop < MAX_BINDING_HOPS; hop++) {
    let cands = (ctx.bindings.get(service) ?? []).filter((c) => {
      if (c.isTest && !sourceIsTest) return false;
      return sameTypeSpace(sourceFile, analysis.language, c.file, ctx.languageOf.get(c.file) ?? "");
    });
    if (!byToken) {
      cands = point.qualifier && hop === 0
        ? cands.filter((c) => c.binding.qualifier === point.qualifier)
        : cands.filter((c) => !c.binding.keyedOnly);
      // Registrations name a type by its bare name: one registers THIS
      // definition only when its name resolves, from the registering file,
      // to the definition the injection point means (two packages may each
      // declare an `IAppService` with its own `AppService`).
      if (serviceFile) {
        const want = serviceFile;
        cands = cands.filter((c) => typeFileFor(ctx, c.binding.service, c.file, c.projectId) === want);
      }
    }
    const contextual = cands.filter((c) => c.binding.consumer && c.binding.consumer === consumer);
    cands = contextual.length > 0 ? contextual : cands.filter((c) => !c.binding.consumer);
    // A container never injects a class into itself: when the consuming class
    // is itself registered for this service, its member of that type is a
    // decorated inner instance or a computed value — something the
    // registrations do not decide (and another app's registration of the same
    // interface is certainly not it).
    if (consumer && cands.some((c) => c.binding.implementation === consumer && implFile(c) === sourceFile)) return null;
    const own = cands.filter((c) => c.projectId === analysis.projectId);
    if (own.length > 0) cands = own;

    const chosen = decideBinding(cands, member, (c) => `${implFile(c) ?? "?"}\0${c.binding.implementation}`);
    if (!chosen) return null;
    let implName = chosen.binding.implementation;
    let classFile = locateClass(ctx, implName, chosen.file, chosen.projectId)
      ?? locateClass(ctx, implName, sourceFile, analysis.projectId);
    if (!classFile && !ctx.bindings.has(implName)) {
      // A registration may name the PROVIDER function that builds the
      // instance (an fx/dig constructor declared in another file): the class
      // is its declared return type.
      const built = providerReturnType(ctx, implName, chosen.file, chosen.projectId);
      const builtFile = built ? locateClass(ctx, built, chosen.file, chosen.projectId) : null;
      // A provider declared to return the interface itself decides nothing.
      if (built && builtFile && ctx.classAt.get(memberKey(builtFile, built))?.kind !== "interface") {
        implName = built;
        classFile = builtFile;
      }
    }
    const kind = classFile ? ctx.classAt.get(memberKey(classFile, implName))?.kind : undefined;
    // An alias (`useExisting`, a binding to another bound interface): follow it.
    if ((!classFile || kind === "interface") && implName !== service && ctx.bindings.has(implName)) {
      service = implName;
      byToken = false;
      member = "";
      consumer = "";
      serviceFile = classFile;
      continue;
    }
    return classFile ? { className: implName, classFile } : null;
  }
  return null;
}

/**
 * The class a provider function returns: the one function named `name` in the
 * registration's directory, else its sub-project, whose declared return type
 * normalizes to a class. Unique-or-nothing.
 */
function providerReturnType(ctx: LinkContext, name: string, nearFile: string, projectId: string): string | null {
  ctx.functionsByName ??= buildFunctionsByName(ctx.analyses);
  const fns = ctx.functionsByName.get(name) ?? [];
  const dir = nearFile.slice(0, nearFile.lastIndexOf("/") + 1);
  const pool = fns.filter((f) => f.file.slice(0, f.file.lastIndexOf("/") + 1) === dir);
  const scoped = pool.length > 0 ? pool : fns.filter((f) => ctx.projectOf.get(f.file) === projectId);
  if (scoped.length !== 1) return null;
  return receiverTypeName(scoped[0]!.returnType, (ctx.languageOf.get(scoped[0]!.file) ?? "") as Language);
}

function buildFunctionsByName(analyses: FileAnalysis[]): Map<string, Array<{ file: string; returnType: string | null }>> {
  const out = new Map<string, Array<{ file: string; returnType: string | null }>>();
  for (const a of analyses) {
    for (const fn of a.functions) {
      let list = out.get(fn.name);
      if (!list) out.set(fn.name, (list = []));
      list.push({ file: a.filePath, returnType: fn.returnType });
    }
  }
  return out;
}

/** One registration out of the candidates, or null when they disagree. */
function decideBinding(
  cands: IndexedBinding[],
  member: string,
  implKey: (c: IndexedBinding) => string,
): IndexedBinding | null {
  if (cands.length === 0) return null;
  // A default (`TryAdd*`, `@ImplementedBy`) yields to any real registration.
  if (cands.some((c) => !c.binding.ifAbsent)) cands = cands.filter((c) => !c.binding.ifAbsent);
  // Registrations agree when they name the same CLASS — the same definition,
  // not merely the same name.
  const single = (list: IndexedBinding[]): IndexedBinding | null =>
    list.length > 0 && new Set(list.map(implKey)).size === 1 ? list[0]! : null;
  return (
    single(cands) ??
    single(cands.filter((c) => c.binding.primary)) ??
    (member ? single(cands.filter((c) => c.binding.matchesMemberName && c.binding.qualifier === member)) : null)
  );
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
