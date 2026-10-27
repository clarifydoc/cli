import {
  relationForStrategy,
  type ClassInfo,
  type DiBinding,
  type FileAnalysis,
  type FunctionInfo,
  type Language,
  type SymbolLink,
  type SymbolLinkStrategy,
  type CallInfo,
  type Confidence,
  type ParamInfo,
  type PackageEcosystem,
  type RouteInfo,
  type SubProject,
  type GlobalMemberDef,
  type ImportInfo,
} from "../types/analysis.js";
import type { ImportResolveContext, PackageRoot } from "../types/language-plugin.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";
import { commonPrefixLength, extensionFamily } from "../extractors/plugins/shared/path-utils.js";
import { receiverTypeName } from "../extractors/shared/type-parser.js";
import { isTestFile } from "./test-file-detector.js";
import { getLanguageForFile } from "../parsers/language-map.js";
import { ALL_BUILTIN_MEMBERS, BUILTIN_MEMBERS_BY_LANGUAGE, importsNameDirectories, isApiContractLanguage, manifestFor, packageEcosystemsFor, packageMatchingFor, pluginFor, testFilePatternsFor } from "../extractors/registry.js";
import { buildImportDirectoryResolver, packageRootsOf, type ImportDirectoryResolver } from "./import-directories.js";
import { SELF_HEADS, bareSupertypeName, declaredSupertypes, isConstructor, sameTypeSpace } from "./typed-receivers.js";
import { byOrdinal, byOrdinalKey } from "./ordinal.js";
import { buildTypeAliasIndex, followTypeAlias, type TypeAliasIndex } from "./type-aliases.js";

interface SymbolDef {
  name: string;
  line: number;
  endLine: number;
  /**
   * The declared return type as written — what a call chained onto this one
   * (`a.getB().c()`) is made on. Undefined when overloads of the name declare
   * different ones: the arguments would have to pick, and nothing here does.
   */
  returnType?: string | null;
  /** Only a re-export names it here (`from .impl import Service` in `__init__`): the definition is elsewhere. */
  reexport?: boolean;
}

/**
 * Build a cross-file symbol link table that maps every resolvable call
 * to the function/method definition it targets.
 *
 * Runs as a post-analysis pass after all files have been individually analyzed.
 */
export function buildSymbolLinks(
  input: FileAnalysis[],
  subProjects: readonly SubProject[] = [],
  /** The package-import resolver the project shares (built here when absent). */
  importDirectory?: ImportDirectoryResolver,
): SymbolLink[] {
  // In path order, whatever order the caller holds them in: where two
  // candidates tie, which one an index met first must not depend on it.
  const analyses = input.every((a, i) => i === 0 || byOrdinal(input[i - 1]!.filePath, a.filePath) <= 0)
    ? input
    : [...input].sort(byOrdinalKey((a) => a.filePath));
  const symbolIndex = buildSymbolIndex(analyses);
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  // Design files (a Delphi `.dfm`) name the class their code unit declares;
  // the type catalogs see only the declarations, or every form is ambiguous.
  const typeDecls = analyses.filter((a) => !isDesignFormat(a.language));
  const filePathMap = buildFilePathMap(analyses);
  const typeAliases = buildTypeAliasIndex(analyses, filePathMap);
  const memberTypes = buildMemberTypes(typeDecls, typeAliases);
  const ctx: LinkContext = {
    filePathMap,
    typeAliases,
    symbolIndex,
    memberTypes,
    injectionMap: buildInjectionMap(analyses, memberTypes),
    bindings: buildBindingIndex(analyses),
    classAt: buildClassAt(analyses),
    classFiles: buildClassFiles(typeDecls),
    extensionMethods: buildExtensionMethods(analyses),
    qualifiedDefs: buildQualifiedDefs(symbolIndex, new Map(analyses.map((a) => [a.filePath, a.language as string]))),
    foldedSymbols: new Map(),
    analyses,
    extraLinks: [],
    interfaceImplMap: buildInterfaceImplMap(typeDecls),
    classCatalog: buildClassCatalog(typeDecls),
    classByProject: buildClassCatalogByProject(typeDecls),
    leafCatalog: buildLeafCatalog(symbolIndex, projectOf),
    dirTailIndex: buildDirTailIndex(symbolIndex),
    classNameIndex: buildClassNameIndex(symbolIndex),
    namespaceSuffixIndex: buildNamespaceSuffixIndex(symbolIndex),
    dottedClassSuffixIndex: buildDottedClassSuffixIndex(typeDecls),
    projectOf,
    languageOf: new Map(analyses.map((a) => [a.filePath, a.language as string])),
    importedFilesCache: new Map(),
    packageProjects: buildPackageProjectIndex(subProjects),
    importDirectory: importDirectory ?? buildImportDirectoryResolver(analyses, subProjects),
    packageRoots: packageRootsOf(subProjects),
    packagesByLanguage: new Map(),
    packageImportsCache: new Map(),
    importedProjectsCache: new Map(),
    projectStemsCache: new Map(),
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
    // Contract languages (OpenAPI, GraphQL SDL, …) declare the served surface but
    // carry no handler code — their routes join the implementing method BY NAME
    // (operationId / field / operation).
    const isSpecFile = isApiContractLanguage(analysis.language);

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
          analysis, ctx, true,
        ) ?? resolveDottedOwnerHandler(sourceFile, sourceSymbol, route.handler, route.line, analysis, ctx);
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
        // A route declared on a method (a decorator, an annotation) inside a
        // class is THAT class's method: three controllers in one file each
        // define `get_all`, and the name alone found the first.
        const declaredIn = handlerLink && handlerLink.targetFile === sourceFile && !/[.#]/.test(route.handler)
          ? enclosingMethod(analysis, route.line, route.handler)
          : null;
        if (handlerLink && declaredIn) {
          handlerLink.targetSymbol = declaredIn.symbol;
          handlerLink.targetLine = declaredIn.line;
        }
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
            //
            // The first candidate is linked. It is a guess (AMBIGUOUS) unless
            // the handler names its class and exactly one file defines that
            // class's method (`UserController#index` → the one
            // `UserController.index`): then the route states its target and
            // only the import is missing (INFERRED), and reach through it is
            // not a guess either.
            const srcFamily = extensionFamily(sourceFile);
            const qualParts = route.handler.split(/[#.]/).filter(Boolean);
            const classPart = qualParts.length > 1 ? qualParts[qualParts.length - 2]! : null;
            let first: { filePath: string; def: { name: string; line: number } } | null = null;
            let candidates = 0;
            let exact = 0;
            // A route that names its class fully (`owner`: `League\Http\Controllers\Squad\ShowController`)
            // is that class's method, in the file declaring its namespace, among same-named classes.
            const ownerParts = classPart && route.owner && /[\\.:]/.test(route.owner) ? route.owner.split(/\\|::|\./).filter(Boolean) : null;
            const ownerNamespace = ownerParts && ownerParts[ownerParts.length - 1] === classPart ? ownerParts.slice(0, -1).join("\\").toLowerCase() : null;
            let declared: { filePath: string; def: { name: string; line: number } } | null = null;
            let declaredCount = 0;
            for (const filePath of filesDefining(ctx, handlerName)) {
              const syms = symbolIndex.get(filePath)!;
              const def = syms.get(handlerName)!;
              const tgtFamily = extensionFamily(filePath);
              if (srcFamily && tgtFamily && srcFamily !== tgtFamily) continue;
              if (classPart) {
                const base = filePath.split("/").pop()!.replace(/\.\w+$/, "");
                if (!syms.has(classPart) && !syms.has(`${classPart}.${handlerName}`) && base !== classPart) continue;
                if (def.name === `${classPart}.${handlerName}`) exact++;
                // The class is in this file but the name is another class's member
                // (or a free function beside it): not the handler the route names.
                else if (def.name.includes(".")) {
                  const owner = def.name.slice(0, def.name.lastIndexOf("."));
                  if (owner !== classPart && ![`::${classPart}`, `.${classPart}`, `\\${classPart}`].some((tail) => owner.endsWith(tail))) continue;
                } else {
                  const cls = ctx.classAt.get(memberKey(filePath, classPart));
                  if (cls && (def.line < cls.line || def.line > cls.endLine)) continue;
                }
              }
              candidates++;
              first ??= { filePath, def };
              const ns = ownerNamespace !== null ? (ctx.analysisAt ??= new Map(ctx.analyses.map((a) => [a.filePath, a]))).get(filePath)?.declaredNamespace : undefined;
              if (ns !== undefined && ns.split(/\\|::|\./).filter(Boolean).join("\\").toLowerCase() === ownerNamespace && def.name === `${classPart}.${handlerName}`) {
                declared ??= { filePath, def };
                declaredCount++;
              }
            }
            if (declared && declaredCount === 1) {
              pushRouteLink(declared.filePath, declared.def, "INFERRED", "route-scan");
            } else if (first) {
              const stated = classPart !== null && candidates === 1 && exact === 1;
              pushRouteLink(first.filePath, first.def, stated ? "INFERRED" : "AMBIGUOUS", "route-scan");
            }
          }
        }
      }

      // A route a subclass serves through a base-class action
      // (`RestController<T>.GetResourceByIdWithErrorHandler` for
      // `MatchController`): what the action calls on itself is the subclass's.
      if (route.owner && route.handler && !isSpecFile) links.push(...ownerOverrideLinks(route, sourceFile, sourceSymbol, analysis, ctx));

      // Spec-file routes (JSight/OpenAPI/WSDL/GraphQL): the file declares the
      // API surface but contains no code, so there is no same-repo handler
      // symbol. Join by the spec operationId (route.handler) when present, else
      // derive a handler name from the path — unique-or-nothing, no guessing.
      if (route.kind === "api" && isSpecFile) {
        const specLink = specRouteHandlerLink(route, sourceFile, sourceSymbol, ctx, isSpecJoinExcluded);
        if (specLink) links.push(specLink);
      }

      // Link route → functions it calls. Its body (a lambda or closure written
      // inside a method) sees that method's fields, parameters and typed locals,
      // so its calls resolve in the method's scope and are the route's.
      const scope = route.calls.length > 0 ? callableAtLine(analysis, route.line) : null;
      for (const call of route.calls) {
        const link = resolveCallToDefinition(
          sourceFile, scope ?? sourceSymbol, call, analysis, ctx,
        );
        if (link) links.push(scope ? { ...link, sourceSymbol } : link);
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
  links.push(...inheritedHandlerLinks(analyses, ctx));
  links.push(...parameterDispatchLinks(links, analyses, interfaceImplMap, ctx));
  const handed = handedClientLinks(links, ctx);
  if (handed.length > 0) {
    // The factory stood in for a member it could not name; once the member is found, the stand-in goes —
    // else the call reaches whatever the factory itself calls too.
    const found = new Set(handed.map((l) => `${l.sourceFile}\0${l.sourceSymbol}\0${l.sourceLine}\0${l.callName}`));
    let kept = 0;
    for (const l of links) if (l.strategy !== "factory-via" || !found.has(`${l.sourceFile}\0${l.sourceSymbol}\0${l.sourceLine}\0${l.callName}`)) links[kept++] = l;
    links.length = kept;
    links.push(...handed);
  }

  // Fan-out: emit a link from each interface method to every implementation's
  // matching method so the trace tab can navigate from interface → impls. A
  // call is redirected to a single implementation at the call site already
  // (resolveCallToDefinition), but a route declared on the interface (JAX-RS
  // `@Path` on the API, the class in another module) anchors on the interface
  // method itself, and reaches what it does only through this link.
  for (const [, info] of interfaceImplMap) {
    if (info.impls.length < 1) continue;
    for (const ifaceMethod of info.methods) {
      if (ifaceMethod.inherited) continue; // its own interface's fan-out links it
      const ifaceSymbol = `${info.interfaceName}.${ifaceMethod.name}`;
      for (const impl of info.impls) {
        // Where the method actually is: the class body, a sibling file of its
        // package (Go), or a base class it inherits from.
        const implMethod = findMethodInClass(ctx, impl.className, impl.classFile, ifaceMethod.name);
        // A class that declares none takes the interface's own (a C# `class Match : Club`
        // whose base list names the interface): no implementation to fan out to.
        if (!implMethod || (implMethod.file === info.interfaceFile && implMethod.symbol === ifaceSymbol)) continue;
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

  pickOverloads(deduped, analyses);
  annotateTypeArguments(deduped, ctx);
  return deduped;
}

/**
 * A generic handler dispatches on what its caller hands it: `DoCreate(ctx, obj
 * CObject, a)` calls `obj.Create(s, a)`, and `projectUsersCreate` passes it a
 * `models.ProjectUser` (named in its own parameter or local types). The call
 * site, not the handler, knows the concrete type, so the caller gets a link to
 * that implementation's `Create`. Only when the parameter's type is an
 * interface with implementations, the handler calls a method on the parameter
 * itself, and exactly one implementation is named in the caller's types.
 */
function parameterDispatchLinks(
  links: readonly SymbolLink[],
  analyses: readonly FileAnalysis[],
  interfaceImplMap: Map<string, InterfaceImplInfo>,
  ctx: LinkContext,
): SymbolLink[] {
  const ifaceByName = new Map<string, InterfaceImplInfo | null>();
  for (const info of interfaceImplMap.values()) {
    if (info.impls.length === 0) continue;
    ifaceByName.set(info.interfaceName, ifaceByName.has(info.interfaceName) ? null : info);
  }
  if (ifaceByName.size === 0) return [];
  const bare = (t: string | null | undefined): string => (t ?? "").replace(/^[*&\s]+|\[\]|<.*$/gs, "").split(/[.:\\]/).pop()!.trim();
  type Dispatch = { param: string; iface: InterfaceImplInfo; methods: Array<{ name: string; line: number }> };
  const dispatchOf = new Map<string, Dispatch[]>();
  const fnAt = new Map<string, FunctionInfo>();
  for (const a of analyses) {
    const consider = (symbol: string, fn: FunctionInfo) => {
      fnAt.set(`${a.filePath}\0${symbol}`, fn);
      const out: Dispatch[] = [];
      for (const p of fn.params) {
        const iface = ifaceByName.get(bare(p.type));
        if (!iface) continue;
        const methods = fn.calls.filter((c) => c.name.startsWith(`${p.name}.`) && !c.name.slice(p.name.length + 1).includes("."))
          .map((c) => ({ name: c.name.slice(p.name.length + 1), line: c.line }));
        if (methods.length > 0) out.push({ param: p.name, iface, methods });
      }
      if (out.length > 0) dispatchOf.set(`${a.filePath}\0${symbol}`, out);
    };
    for (const fn of a.functions) consider(fn.name, fn);
    for (const cls of a.classes) for (const m of cls.methods) consider(`${cls.name}.${m.name}`, m);
  }
  if (dispatchOf.size === 0) return [];

  const out: SymbolLink[] = [];
  const seen = new Set<string>();
  const dispatchTo = (l: SymbolLink, dispatches: readonly Dispatch[], mentioned: string): void => {
    for (const d of dispatches) {
      const named = d.iface.impls.filter((impl) => new RegExp(String.raw`(?:^|[^\w])${impl.className}(?![\w])`).test(mentioned));
      if (named.length !== 1) continue;
      const impl = named[0]!;
      for (const m of d.methods) {
        const target = findMethodInClass(ctx, impl.className, impl.classFile, m.name);
        if (!target) continue;
        const key = `${l.sourceFile}\0${l.sourceSymbol}\0${target.file}\0${target.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          sourceFile: l.sourceFile,
          sourceSymbol: l.sourceSymbol,
          sourceLine: l.sourceLine,
          callName: `${d.param}.${m.name}`,
          targetFile: target.file,
          targetSymbol: target.symbol,
          targetLine: target.line,
          confidence: "INFERRED",
          strategy: "interface-redirect",
          relation: relationForStrategy("interface-redirect"),
        });
      }
    }
  };
  for (const l of links) {
    const dispatches = dispatchOf.get(`${l.targetFile}\0${l.targetSymbol}`);
    const caller = dispatches ? fnAt.get(`${l.sourceFile}\0${l.sourceSymbol}`) : undefined;
    if (!dispatches || !caller) continue;
    const mentioned = [...caller.params.map((p) => p.type ?? ""), ...(caller.localTypes ?? []).map((t) => t.type ?? "")].join(" ");
    // A composite literal the call hands the dispatching parameter names its type outright
    // (`DoReadAll(ctx, &models.Club{}, a)`), whatever else the caller's types mention.
    const site = caller.calls.find((c) => c.line === l.sourceLine && c.name === l.callName && c.args);
    const handler = site ? fnAt.get(`${l.targetFile}\0${l.targetSymbol}`) : undefined;
    for (const d of dispatches) {
      const arg = handler ? site!.args![handler.params.findIndex((p) => p.name === d.param)] : undefined;
      const literal = arg ? /^&?([\w.]+)\{/.exec(arg)?.[1] : undefined;
      dispatchTo(l, [d], literal ?? mentioned);
    }
  }

  // A route whose handler's receiver is built for one type (`RouteInfo.handlerTypes`: a Go
  // `WebHandler{EmptyStruct: func() CObject { return &models.Club{} }}` serving `h.ReadOneWeb`)
  // reaches that type's implementation in every generic handler its handler hands the value
  // on to, three calls deep (`ReadOneWeb` → `DoReadOne(obj CObject)` → `obj.ReadOne`).
  const typedRoutes = analyses.flatMap((a) => a.routes.filter((r) => r.handlerTypes?.length).map((r) => ({ a, r })));
  if (typedRoutes.length > 0) {
    const forward = new Map<string, SymbolLink[]>();
    for (const l of links) {
      if (l.navigational) continue;
      const k = `${l.sourceFile}\0${l.sourceSymbol}`;
      (forward.get(k) ?? forward.set(k, []).get(k)!).push(l);
    }
    for (const { a, r } of typedRoutes) {
      const symbol = `route:${r.httpMethod ?? "USE"} ${r.path}`;
      const mentioned = r.handlerTypes!.join(" ");
      const visited = new Set<string>();
      let frontier = [`${a.filePath}\0${symbol}`];
      for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const k of frontier) {
          for (const l of forward.get(k) ?? []) {
            const tk = `${l.targetFile}\0${l.targetSymbol}`;
            if (visited.has(tk)) continue;
            visited.add(tk);
            const dispatches = dispatchOf.get(tk);
            if (dispatches) {
              dispatchTo({ ...l, sourceFile: a.filePath, sourceSymbol: symbol, sourceLine: r.line }, dispatches, mentioned);
            } else next.push(tk);
          }
        }
        frontier = next;
      }
    }
  }
  return out;
}

/**
 * A client handed to the factory that builds what the caller uses: the screen
 * calls `clubStore.actions.updateOne(club)` on `const clubStore = useClubStore()`,
 * `useClubStore` returns `useStore("club", store, api.clubs)`, `useStore` passes
 * its `api` on to `useStoreActions(key, api)`, and the `updateOne` that factory
 * returns calls `api.updateOne(…)`. The call site resolved only to the factory
 * (`factory-via`); this follows the argument (`CallInfo.args`) through the
 * parameters it is handed on as, to the members a function of the leaf's name
 * nested in the receiving factory calls on it, and resolves each on the
 * argument where the factory was given it (`api.clubs.updateOne` → the clubs
 * client's own request). Unique per argument, three hand-offs deep.
 */
function handedClientLinks(links: readonly SymbolLink[], ctx: LinkContext): SymbolLink[] {
  type Fn = { fn: FunctionInfo; file: string; symbol: string };
  const fnAt = new Map<string, Fn>();
  const fnsIn = new Map<string, Fn[]>();
  let anyArgs = false;
  for (const a of ctx.analyses) {
    const list: Fn[] = [];
    for (const fn of a.functions) {
      const entry = { fn, file: a.filePath, symbol: fn.name };
      fnAt.set(`${a.filePath}\0${fn.name}`, entry);
      list.push(entry);
      if (!anyArgs && fn.calls.some((c) => c.args)) anyArgs = true;
    }
    fnsIn.set(a.filePath, list);
  }
  if (!anyArgs) return [];
  // What each call made in a function resolved to: `${file}\0${symbol}\0${line}\0${callName}`.
  const resolved = new Map<string, SymbolLink>();
  for (const l of links) {
    if (l.relation === "reference") continue;
    resolved.set(`${l.sourceFile}\0${l.sourceSymbol}\0${l.sourceLine}\0${l.callName}`, l);
  }
  const NAME = /^[\w$]+$/;
  const CHAIN = /^[\w$]+(?:\.[\w$]+)+$/;
  /** The members functions named `leaf` nested in `at` call on its parameter `index`, through the calls handing it on. */
  const usesOf = (at: Fn, index: number, leaf: string, depth: number, seen: Set<string>): string[] => {
    const param = at.fn.params[index]?.name;
    const key = `${at.file}\0${at.symbol}\0${index}`;
    if (!param || !NAME.test(param) || depth > 3 || seen.has(key)) return [];
    seen.add(key);
    const out = new Set<string>();
    for (const inner of fnsIn.get(at.file) ?? []) {
      if (inner === at || inner.symbol !== leaf || inner.fn.line < at.fn.line || inner.fn.endLine > at.fn.endLine) continue;
      // The nested function's own parameter of that name shadows the factory's.
      if (inner.fn.params.some((p) => p.name === param)) continue;
      for (const c of inner.fn.calls) {
        const parts = c.name.split(".");
        if (parts.length === 2 && parts[0] === param && NAME.test(parts[1]!)) out.add(parts[1]!);
      }
    }
    for (const c of at.fn.calls) {
      const i = c.args?.indexOf(param) ?? -1;
      if (i < 0) continue;
      const hop = resolved.get(`${at.file}\0${at.symbol}\0${c.line}\0${c.name}`);
      const next = hop ? fnAt.get(`${hop.targetFile}\0${hop.targetSymbol}`) : undefined;
      if (next) for (const m of usesOf(next, i, leaf, depth + 1, seen)) out.add(m);
    }
    return [...out];
  };

  const out: SymbolLink[] = [];
  for (const l of links) {
    if (l.strategy !== "factory-via") continue;
    const factory = fnAt.get(`${l.targetFile}\0${l.targetSymbol}`);
    const leaf = l.callName.split(".").pop()!;
    const analysis = ctx.analysisAt?.get(l.targetFile) ?? ctx.analyses.find((a) => a.filePath === l.targetFile);
    if (!factory || !analysis || !l.callName.includes(".")) continue;
    for (const c of factory.fn.calls) {
      if (!c.args) continue;
      const hop = resolved.get(`${factory.file}\0${factory.symbol}\0${c.line}\0${c.name}`);
      const next = hop ? fnAt.get(`${hop.targetFile}\0${hop.targetSymbol}`) : undefined;
      if (!next) continue;
      c.args.forEach((arg, i) => {
        // A chain the factory itself holds; its own parameter is its caller's to say.
        if (!CHAIN.test(arg) || factory.fn.params.some((p) => p.name === arg.split(".")[0])) return;
        for (const member of usesOf(next, i, leaf, 0, new Set())) {
          const link = resolveCallToDefinition(factory.file, factory.symbol, { name: `${arg}.${member}`, kind: "internal", target: null, line: c.line }, analysis, ctx);
          if (!link || link.strategy === "factory-via" || link.strategy?.startsWith("unique-global")) continue;
          out.push({ ...link, sourceFile: l.sourceFile, sourceSymbol: l.sourceSymbol, sourceLine: l.sourceLine, callName: l.callName, confidence: "INFERRED" });
        }
      });
    }
  }
  return out;
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
      const prev = fileSymbols.get(fn.name);
      fileSymbols.set(fn.name, {
        name: fn.name,
        line: fn.line,
        endLine: fn.endLine,
        returnType: overloadReturn(prev, fn.returnType),
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
        const prev = fileSymbols.get(qualified);
        fileSymbols.set(qualified, {
          name: qualified,
          line: method.line,
          endLine: method.endLine,
          returnType: overloadReturn(prev, method.returnType),
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
          ...(exp.kind === "re-export" ? { reexport: true } : {}),
        });
      }
    }

    index.set(analysis.filePath, fileSymbols);
  }

  return index;
}

/**
 * Point each link to an overloaded method at the overload the call can mean.
 * The symbol index keys `Class.method` once, so every overload's call landed
 * on the last one declared: with `save(Order)` and `save(Order, boolean)`,
 * `svc.save(o)` showed the second body. The call's argument count
 * (`CallInfo.argCount`) picks the one overload whose arity accepts it —
 * required parameters up to all of them, any number past a variadic one;
 * when none or several do, the link is left as it was. Parameter types are
 * not compared: the arguments' types are not known here.
 */
function pickOverloads(links: SymbolLink[], analyses: readonly FileAnalysis[]): void {
  type Overload = { line: number; min: number; max: number };
  const overloads = new Map<string, Overload[]>();
  const add = (file: string, name: string, fn: FunctionInfo): void => {
    const params = fn.params.filter((p) => !p.isReceiver);
    const variadic = fn.variadic || params.some((p) => p.variadic);
    const min = params.filter((p) => !p.variadic && !p.optional && p.defaultValue == null).length;
    const key = `${file}\u0000${name}`;
    let list = overloads.get(key);
    if (!list) overloads.set(key, (list = []));
    list.push({ line: fn.line, min, max: variadic ? Number.POSITIVE_INFINITY : params.length });
  };
  for (const a of analyses) {
    // A second definition is no overload where the language has none (a TS overload signature, a typing stub).
    if (pluginFor(a.language)?.calls?.noOverloads) continue;
    for (const fn of a.functions) add(a.filePath, fn.name, fn);
    for (const cls of a.classes) for (const m of cls.methods) add(a.filePath, `${cls.name}.${m.name}`, m);
  }
  for (const [key, list] of overloads) if (list.length < 2) overloads.delete(key);
  if (overloads.size === 0) return;

  // The argument count of each call site, read only when some link needs it.
  let argCounts: Map<string, number> | null = null;
  const argCountAt = (file: string, line: number, callName: string): number | undefined => {
    if (!argCounts) {
      argCounts = new Map();
      const record = (file: string, calls: readonly CallInfo[]): void => {
        for (const c of calls) if (c.argCount !== undefined) argCounts!.set(`${file}\u0000${c.line}\u0000${c.name}`, c.argCount);
      };
      for (const a of analyses) {
        for (const fn of a.functions) record(a.filePath, fn.calls);
        for (const cls of a.classes) for (const m of cls.methods) record(a.filePath, m.calls);
      }
    }
    return argCounts.get(`${file}\u0000${line}\u0000${callName}`);
  };

  // The arguments describe the target only when the call IS to it: `svc.save(o)`
  // → `save`, `new Builder(x)` → the `Builder` constructor — not a link a type
  // argument made (`Assert.Throws<MyException>(…)` → `MyException`'s constructor).
  const leafOf = (name: string): string =>
    name.replace(/^new\s+/, "").replace(/<.*$/s, "").split(/\.|::/).pop() ?? "";
  for (const link of links) {
    const list = overloads.get(`${link.targetFile}\u0000${link.targetSymbol}`);
    if (!list || leafOf(link.callName) !== leafOf(link.targetSymbol)) continue;
    const n = argCountAt(link.sourceFile, link.sourceLine, link.callName);
    if (n === undefined) continue;
    const fits = list.filter((o) => n >= o.min && n <= o.max);
    if (fits.length === 1) link.targetLine = fits[0]!.line;
  }
}

/** A name's return type once another definition of it (an overload) is seen: kept only when both agree. */
function overloadReturn(prev: SymbolDef | undefined, returnType: string | null): string | null | undefined {
  if (!prev) return returnType;
  return prev.returnType === returnType ? returnType : undefined;
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
 *   GET /find-players                     → findPlayers
 * Unique-or-nothing across non-test files; misses stay unlinked (no guess).
 */
function specRouteHandlerLink(
  route: { path: string; httpMethod: string | null; line: number; handler?: string | null; contract?: { type: string; method: string } },
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
  // and OpenAPI carry it verbatim; JSight names it only as its contract's
  // operation, and falls to the path without one.
  const opId = route.handler
    ? route.handler.includes(".") ? route.handler.split(".").pop()! : route.handler
    : route.contract?.method ?? null;
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
  const link = (cand: string, file: string, def: SymbolDef): SymbolLink => ({
    sourceFile,
    sourceSymbol,
    sourceLine: route.line,
    callName: cand,
    targetFile: file,
    targetSymbol: def.name,
    targetLine: def.line,
    confidence: "INFERRED",
    strategy: "spec-join",
    relation: "calls",
  });
  // A class method implements it: the JAX-WS / JAX-RS class implementing the
  // interface generated from the spec at build time (`FixtureFeedServiceImpl
  // implements FixtureFeedServicePort`, the WSDL portType; `PetApiImpl
  // implements PetApi`). The interface is not in the source, so the join is by
  // the operation's name, among implementors of the route's contract type —
  // unique-or-nothing.
  // Only an implementor: a class of the same name is the generated CLIENT
  // (`UsersApi.listUsers` in a TypeScript SDK), the caller, not the code.
  // Tried first: a class stating the contract outranks a function that merely
  // shares the operation's name (a client wrapper `getCart` beside the stubs).
  const contractType = route.contract?.type.split(".").pop();
  // A code row declaring the same operation (a grpc-js `addService` handler,
  // a resource implementing a jar's interface) is where it is served.
  if (contractType && route.contract) {
    const served = codeContractRoutes(ctx).get(`${contractType}#${route.contract.method.toLowerCase()}`)?.filter((r) => !isExcluded(r.file)) ?? [];
    if (served.length > 1) return null;
    if (served.length === 1) return link(served[0]!.symbol, served[0]!.file, { name: served[0]!.symbol, line: served[0]!.line, endLine: served[0]!.line });
  }
  for (const cand of contractType && opId ? candidates.slice(0, 2) : []) {
    const methods = methodLeafIndex(ctx).get(cand)?.filter((m) => !isExcluded(m.file) && !isApiContractLanguage(ctx.languageOf.get(m.file) as Language)) ?? [];
    // The class states the contract — implementing the interface by name, or
    // extending the base protoc generated for the service (`GreeterBase`, …).
    const states = (file: string, cls: ClassInfo | undefined): boolean =>
      !!cls && (cls.implements.some((t) => t.replace(/<.*$/, "").split(".").pop() === contractType) ||
        pluginFor(ctx.languageOf.get(file) as Language)?.grpcServiceOf?.(cls) === contractType);
    const pick = methods.filter((m) => statesThrough(m.file, m.className, states, ctx));
    // Several classes serving the operation: the source does not say which, and
    // a function that only shares its name is no better answer.
    if (pick.length > 1) return null;
    if (pick.length !== 1) continue;
    const def = ctx.symbolIndex.get(pick[0]!.file)?.get(pick[0]!.symbol);
    if (def) return link(cand, pick[0]!.file, def);
  }
  // A spec generated from the code (NestJS, Swashbuckle and springdoc name an
  // operation after its handler): the one code route of the same verb whose
  // handler has the operation's name serves it.
  if (opId && verb) {
    const served = codeHandlerRoutes(ctx).get(`${verb} ${opId.toLowerCase()}`)?.filter((r) => !isExcluded(r.file)) ?? [];
    if (served.length === 1) {
      const r = served[0]!;
      const def = ctx.symbolIndex.get(r.file)?.get(r.handler) ?? { name: r.handler, line: r.line, endLine: r.line };
      return link(opId, r.file, def);
    }
    if (served.length > 1) return null;
  }
  for (const cand of candidates) {
    // classNameIndex maps every dot-free symbol name to its defining files in
    // symbolIndex order — same uniqueness semantics as a full scan, O(hits).
    const files = (ctx.classNameIndex.get(cand) ?? []).filter((f) => !isExcluded(f));
    if (files.length !== 1) continue;
    const def = ctx.symbolIndex.get(files[0]!)?.get(cand);
    if (!def) continue;
    return link(cand, files[0]!, def);
  }
  return null;
}

const codeHandlerCache = new WeakMap<object, Map<string, Array<{ file: string; handler: string; line: number }>>>();

/** Code API routes (not a spec's) by `<verb> <handler's own name, lower-cased>`. */
function codeHandlerRoutes(ctx: LinkContext): Map<string, Array<{ file: string; handler: string; line: number }>> {
  let idx = codeHandlerCache.get(ctx.analyses);
  if (idx) return idx;
  idx = new Map();
  for (const a of ctx.analyses) {
    if (isApiContractLanguage(a.language)) continue;
    for (const r of a.routes) {
      if (r.kind !== "api" || !r.handler || !r.httpMethod) continue;
      const leaf = r.handler.split(/[.#:]/).pop()!;
      const key = `${r.httpMethod.toLowerCase()} ${leaf.toLowerCase()}`;
      (idx.get(key) ?? idx.set(key, []).get(key)!).push({ file: a.filePath, handler: r.handler, line: r.line });
    }
  }
  codeHandlerCache.set(ctx.analyses, idx);
  return idx;
}

const codeContractCache = new WeakMap<object, Map<string, Array<{ file: string; symbol: string; line: number }>>>();

/** Routes of code (not of a spec) declaring a contract, by `<Type>#<method lower-cased>`. */
function codeContractRoutes(ctx: LinkContext): Map<string, Array<{ file: string; symbol: string; line: number }>> {
  let idx = codeContractCache.get(ctx.analyses);
  if (idx) return idx;
  idx = new Map();
  for (const a of ctx.analyses) {
    if (isApiContractLanguage(a.language)) continue;
    for (const r of a.routes) {
      if (!r.contract || r.kind !== "api") continue;
      const key = `${r.contract.type.split(".").pop()}#${r.contract.method.toLowerCase()}`;
      (idx.get(key) ?? idx.set(key, []).get(key)!).push({ file: a.filePath, symbol: `route:${r.httpMethod ?? "USE"} ${r.path}`, line: r.line });
    }
  }
  codeContractCache.set(ctx.analyses, idx);
  return idx;
}

/** Whether a class, or a project base class of it, states the contract (`EmailService(BaseEmailService)`, the base the Servicer). */
function statesThrough(file: string, className: string, states: (file: string, cls: ClassInfo | undefined) => boolean, ctx: LinkContext): boolean {
  let f = file;
  let name = className;
  for (let depth = 0; depth < MAX_BASE_DEPTH; depth++) {
    const cls = ctx.classAt.get(memberKey(f, name));
    if (states(f, cls)) return true;
    const base = bareClassName(cls?.extends);
    const entry = base ? classEntryFor(ctx.classCatalog.get(base), f) : undefined;
    if (!entry || entry.count !== 1) return false;
    f = entry.file;
    name = base;
  }
  return false;
}

const methodLeafCache = new WeakMap<object, Map<string, Array<{ file: string; symbol: string; className: string }>>>();

/** Class methods by their own name: `getUser` → every `X.getUser`, across the project. */
function methodLeafIndex(ctx: LinkContext): Map<string, Array<{ file: string; symbol: string; className: string }>> {
  let idx = methodLeafCache.get(ctx.symbolIndex);
  if (idx) return idx;
  idx = new Map();
  for (const [file, syms] of ctx.symbolIndex) {
    for (const name of syms.keys()) {
      const dot = name.lastIndexOf(".");
      if (dot <= 0) continue;
      const className = name.slice(0, dot);
      if (!ctx.classAt.has(memberKey(file, className))) continue;
      const leaf = name.slice(dot + 1);
      (idx.get(leaf) ?? idx.set(leaf, []).get(leaf)!).push({ file, symbol: name, className });
    }
  }
  methodLeafCache.set(ctx.symbolIndex, idx);
  return idx;
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

/**
 * Per sub-project, every class name → the first file declaring it, the count
 * of declarations and the files themselves, so a class-name lookup can tell a
 * unique definition from a name declared in several places.
 */
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
/** Is `language` a design format (`designFormat`: a Delphi `.dfm`) rather than code declaring types? */
function isDesignFormat(language: string | undefined): boolean {
  return !!language && pluginFor(language as Language)?.designFormat === true;
}

/** Class-level call names that construct an instance in `language` (`constructorCalls`). */
function constructorCallsOf(language: string | undefined): readonly string[] {
  return (language && pluginFor(language as Language)?.constructorCalls) || [];
}

/** Are `language`'s function and method names case-insensitive (all of its identifiers, or `caseInsensitiveCallables` — PHP)? */
function callablesFoldCase(language: string | undefined): boolean {
  if (!language) return false;
  const plugin = pluginFor(language as Language);
  return plugin?.caseInsensitiveNames === true || plugin?.caseInsensitiveCallables === true;
}
/** A symbol name as the language compares it: lowercased for case-insensitive languages. */
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
  // The referencing file's own directory before a subdirectory sharing its whole path.
  const nearDir = nearFile.slice(0, nearFile.lastIndexOf("/") + 1);
  const sameDir = files.filter((f) => f.slice(0, f.lastIndexOf("/") + 1) === nearDir);
  if (sameDir.length > 0 && sameDir.length < files.length) return pickDefinition(name, sameDir, nearFile, declOf, languageOf);
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
    !(TEST_FIXTURE_PATH_RE.test(entry.file) && !TEST_FIXTURE_PATH_RE.test(sourceFile)) &&
    // Production code never reaches into a test by name alone (a Flutter `integration_test/` helper).
    !(isTestFile(entry.file, getLanguageForFile(entry.file) ?? undefined) && !isTestFile(sourceFile, getLanguageForFile(sourceFile) ?? undefined))
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

/**
 * A template's event handler that names a method its component class inherits
 * (`(click)="cancel()"` in a dialog extending a base dialog that declares
 * `cancel`): the click runs the base class's method. Linked from the file's
 * `<component>` anchor — the markup has no function of its own — so the trace
 * and the screen's reach follow it. A method the file declares itself needs
 * no link: the handler names it in place.
 */
function inheritedHandlerLinks(analyses: readonly FileAnalysis[], ctx: LinkContext): SymbolLink[] {
  const out: SymbolLink[] = [];
  for (const a of analyses) {
    if (!a.interactiveElements?.length || !a.classes.some((c) => c.extends)) continue;
    const own = new Set([...a.functions.map((f) => f.name), ...a.classes.flatMap((c) => [...c.methods.map((m) => m.name), ...c.properties.map((p) => p.name)])]);
    const done = new Set<string>();
    for (const el of a.interactiveElements) {
      const name = el.handler ? /^\s*(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:\(|$)/.exec(el.handler)?.[1] : undefined;
      if (!name || own.has(name) || done.has(name)) continue;
      done.add(name);
      for (const cls of a.classes) {
        if (!cls.extends) continue;
        const hit = findMethodInClass(ctx, cls.name, a.filePath, name);
        if (!hit || (hit.file === a.filePath && hit.symbol.startsWith(`${cls.name}.`))) continue;
        out.push({
          sourceFile: a.filePath,
          sourceSymbol: "<component>",
          sourceLine: el.line,
          callName: name,
          targetFile: hit.file,
          targetSymbol: hit.symbol,
          targetLine: hit.line,
          confidence: "EXTRACTED",
          strategy: "inheritance",
          relation: relationForStrategy("inheritance"),
        });
        break;
      }
    }
  }
  return out;
}

/** Lookup tables built once per buildSymbolLinks run, shared by every call resolution. */
interface LinkContext {
  filePathMap: Map<string, string>;
  /** Files per directory (with trailing `/`), built on first use by `directoryScope` languages. */
  directoryFiles?: Map<string, string[]>;
  /** Names some project function or method bears, built on first use. */
  callableNames?: Set<string>;
  /** `${family}\0${package}` → the files declaring it (`importsNamePackages`), built on first use. */
  packageFiles?: Map<string, string[]>;
  /** Per file, the files it sees by package (`importsNamePackages`). */
  packageScopeCache?: Map<string, Set<string>>;
  /** Symbol name → the files whose symbols include it, in `symbolIndex` order (built on first use). */
  filesBySymbol?: Map<string, string[]>;
  /** Analyzed files by file name, built on first use (`autoloadedFiles`). */
  filesByName?: Map<string, string[]>;
  /** Analyses by path, built on first use (re-export following). */
  analysisByFile?: Map<string, FileAnalysis>;
  /** What a plugin's import resolver asks of the project, built on first use. */
  importResolve?: ImportResolveContext;
  /** Free functions by language + namespace-qualified name (lowercased), built on first use. */
  namespacedFunctions?: Map<string, Array<{ file: string; def: SymbolDef }>>;
  symbolIndex: Map<string, Map<string, SymbolDef>>;
  /** Type aliases the files declare, followed for declared receiver types (null: none). */
  typeAliases: TypeAliasIndex | null;
  /** Lazy: `${file}\0${class}` → its base class as located from that file (null: none in the project). */
  parentAt?: Map<string, { parentClass: string; parentFile: string } | null>;
  /** `${file}\0${class}` → member → declared type (own + inherited). */
  memberTypes: Map<string, Map<string, InjectionPoint>>;
  /** File-level flattening of `memberTypes`, for calls outside a class body. */
  injectionMap: Map<string, InjectionPoint>;
  /** DI container registrations by service. */
  bindings: Map<string, IndexedBinding[]>;
  /** `${file}\0${class}` → its ClassInfo (kind, base class). */
  classAt: Map<string, ClassInfo>;
  /** Base class → the classes extending it, built on first use (`overrideBelow`). */
  subclasses?: Map<string, Array<{ name: string; file: string }>>;
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
  /**
   * Classes whose own name is dotted (an Elixir module `PlausibleWeb.OAuth.MetadataController`),
   * by every dotted suffix of that name — what a Phoenix route names its controller by
   * (`OAuth.MetadataController`, under `scope "/", PlausibleWeb`). `classNameIndex` leaves
   * dotted names out, since there a dot means `Class.member`.
   */
  dottedClassSuffixIndex: Map<string, Array<{ file: string; name: string }>>;
  /** A namespaced class's trailing names (`Routes::Misc`, `Misc` of
   *  `Invidious::Routes::Misc`) → the declarations ending that way. Strategy 4's
   *  relative-constant fallback. */
  namespaceSuffixIndex: Map<string, Array<{ file: string; name: string }>>;
  /** filePath → sub-project id, for project-scoped candidate selection. */
  projectOf: Map<string, string>;
  /** Lazy: sub-projects whose exports are global without an import (`importsBindNames.autoImport`). */
  autoImportProjects?: Set<string>;
  /** filePath → language, for type-space checks on formats without an extension family. */
  languageOf: Map<string, string>;
  /** Lazy per-file cache: files this file's imports resolve to (Strategy 4's
   *  cross-project gate). */
  importedFilesCache: Map<string, Set<string>>;
  /** The project directory a package import names (`import-directories.ts`; Go by its go.mod module path). */
  importDirectory: ImportDirectoryResolver;
  /** The repository's packages by ecosystem (`import-directories.ts` `packageRootsOf`). */
  packageRoots: Map<string, PackageRoot[]>;
  /** Per language: the packages of its ecosystems, built on first use (`importPath`). */
  packagesByLanguage: Map<Language, PackageRoot[]>;
  /** Per package (directory + test flag): the files of the packages its files import (`packageScoped` languages). */
  packageImportsCache: Map<string, Set<string>>;
  /**
   * Sub-projects by the package their manifest declares, keyed per ecosystem
   * the way that ecosystem's `PackageManagerSpec` keys packages
   * (`packageKey`): what an import of a sibling sub-project resolves against,
   * with the same `importKey`/`prefixMatch` rules the dependency inventory
   * uses — `league_db_views_site::SiteView` (Cargo), `@acme/ui/Button` (npm),
   * `code.example.com/league/models/user` (Go), `my_pkg.models` (pypi).
   */
  packageProjects: Map<PackageEcosystem, Array<{ key: string; projectId: string }>>;
  /** Sub-projects an analysis imports by package (see `importedProjectsOf`). */
  importedProjectsCache: Map<string, Set<string>>;
  /** File stems of a sub-project's files, computed once per project. */
  projectStemsCache: Map<string, Set<string>>;
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

/**
 * A language whose package is its directory AND whose imports name package
 * directories (Go): an import loads every file of one directory, and what one
 * file of a package imports is in scope for its siblings' values too.
 */
function packageScoped(language: string): boolean {
  return importsNameDirectories(language) && !!pluginFor(language as Language)?.directoryScope;
}

/**
 * A test of its package by the language's own rule (`_test.go`), which no
 * import loads — not by directory name: `modules/test` is a package like any.
 */
function packageTest(ctx: LinkContext, file: string): boolean {
  const language = (ctx.languageOf.get(file) ?? "") as Language;
  const own = testFilePatternsFor(language);
  return own.length > 0 ? own.some((re) => re.test(file)) : isTestFile(file, language);
}

/** The files of a package an import names: the directory's files of the importer's family, never its tests. */
function packageFilesOf(ctx: LinkContext, dir: string, fromFile: string): string[] {
  ctx.directoryFiles ??= filesByDirectory(ctx.analyses);
  const family = extensionFamily(fromFile);
  return (ctx.directoryFiles.get(dir ? `${dir}/` : "") ?? []).filter(
    (f) => f !== fromFile && extensionFamily(f) === family && !packageTest(ctx, f),
  );
}

/** Files the analysis's imports resolve to (cached per source file). */
function importedFilesOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  let set = ctx.importedFilesCache.get(analysis.filePath);
  if (!set) {
    if (packageScoped(analysis.language)) {
      set = packageImportsOf(analysis, ctx);
    } else {
      set = new Set();
      for (const imp of analysis.imports) for (const f of importFiles(ctx, imp, analysis.filePath)) if (f !== analysis.filePath) set.add(f);
      // Files its loader finds by the constants it names (Zeitwerk) count as imported.
      const autoload = manifestFor(analysis.language as Language)?.autoloadedFiles;
      if (autoload) for (const f of autoload(analysis, (suffix) => filesEndingWith(ctx, suffix))) if (f !== analysis.filePath) set.add(f);
      forwardThroughBarrels(set, analysis.filePath, ctx);
    }
    ctx.importedFilesCache.set(analysis.filePath, set);
  }
  return set;
}

/**
 * The files one import names: by the language's own module rules where it has
 * them (`resolveImport`: Rust `use crate::graph::{Node, Edge}` → the file
 * declaring each name, through the module's glob re-exports), else by
 * `importPath`.
 */
function importFiles(ctx: LinkContext, imp: ImportInfo, fromFile: string): string[] {
  const language = ctx.languageOf.get(fromFile) as Language | undefined;
  const own = language ? manifestFor(language)?.resolveImport : undefined;
  if (!own) {
    const f = importPath(ctx, imp.source, fromFile);
    return f ? [f] : [];
  }
  const out = new Set<string>();
  for (const spec of imp.specifiers.length > 0 ? imp.specifiers : [undefined]) {
    const f = own(fromFile, imp.source, spec === "*" ? undefined : spec, importResolveContext(ctx));
    if (f && ctx.filePathMap.get(f) === f) out.add(f);
  }
  return [...out];
}

/** The files whose symbols include `name`, in `symbolIndex` order (an index over every name, built on first use). */
function filesDefining(ctx: LinkContext, name: string): readonly string[] {
  if (!ctx.filesBySymbol) {
    ctx.filesBySymbol = new Map();
    for (const [file, syms] of ctx.symbolIndex) {
      for (const key of syms.keys()) {
        const list = ctx.filesBySymbol.get(key);
        if (list) list.push(file);
        else ctx.filesBySymbol.set(key, [file]);
      }
    }
  }
  return ctx.filesBySymbol.get(name) ?? [];
}

/** Analyzed files whose path is `suffix` or ends with `/suffix` (index by file name, built on first use). */
function filesEndingWith(ctx: LinkContext, suffix: string): readonly string[] {
  if (!ctx.filesByName) {
    ctx.filesByName = new Map();
    for (const a of ctx.analyses) {
      const name = a.filePath.slice(a.filePath.lastIndexOf("/") + 1);
      const list = ctx.filesByName.get(name);
      if (list) list.push(a.filePath);
      else ctx.filesByName.set(name, [a.filePath]);
    }
  }
  const files = ctx.filesByName.get(suffix.slice(suffix.lastIndexOf("/") + 1)) ?? [];
  return suffix.includes("/") ? files.filter((f) => f === suffix || f.endsWith(`/${suffix}`)) : files;
}

/**
 * A file that declares nothing of its own and only imports — a barrel
 * (`export 'operations/table_style.dart';` lines, an `index.ts` of `export *`)
 * — hands on what it loads: its imports join the importer's, three barrels deep.
 */
function forwardThroughBarrels(set: Set<string>, importer: string, ctx: LinkContext): void {
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  let frontier = [...set];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      const barrel = ctx.analysisByFile.get(file);
      if (!barrel || barrel.functions.some((f) => !f.name.startsWith("<")) || barrel.classes.length > 0) continue;
      for (const imp of barrel.imports) {
        for (const f of importFiles(ctx, imp, file)) {
          if (f === importer || set.has(f)) continue;
          set.add(f);
          next.push(f);
        }
      }
    }
    frontier = next;
  }
}

/**
 * The files of every package the analysis's package imports (`packageScoped`):
 * a Go value's type is in scope wherever any file of the package imported it —
 * `t.Owner.Name()` in one file, the `user` import in the file declaring the
 * struct. A production file counts its non-test siblings; a test file adds its own.
 */
function packageImportsOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  const file = analysis.filePath;
  const dir = file.slice(0, Math.max(0, file.lastIndexOf("/")));
  const isTest = packageTest(ctx, file);
  const key = `${dir}\0${isTest ? file : ""}`;
  let set = ctx.packageImportsCache.get(key);
  if (set) return set;
  set = new Set();
  ctx.directoryFiles ??= filesByDirectory(ctx.analyses);
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  const family = extensionFamily(file);
  const members = (ctx.directoryFiles.get(dir ? `${dir}/` : "") ?? []).filter(
    (f) => f === file || (extensionFamily(f) === family && !packageTest(ctx, f)),
  );
  for (const member of members) {
    const a = ctx.analysisByFile.get(member);
    if (!a) continue;
    for (const imp of a.imports) {
      const target = ctx.importDirectory(imp.source, member);
      if (target === null || target === dir) continue;
      for (const f of packageFilesOf(ctx, target, member)) set.add(f);
    }
  }
  ctx.packageImportsCache.set(key, set);
  return set;
}

/**
 * Sub-projects the analysis imports by declared package name: an import that
 * resolves to no file of this project but names a sibling sub-project — a
 * Cargo workspace member (`use league_db_views_site::SiteView`), an npm
 * workspace package, a Go module path. None resolve by path, since the name
 * is the manifest's, not the directory's. Kept as project ids, not expanded
 * to the project's files: a shared package imported by thousands of files
 * would otherwise be copied into each importer's set.
 */
function importedProjectsOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  let set = ctx.importedProjectsCache.get(analysis.filePath);
  if (!set) {
    set = new Set();
    if (ctx.packageProjects.size > 0) {
      const byDirectory = packageScoped(analysis.language);
      for (const imp of analysis.imports) {
        if (byDirectory ? ctx.importDirectory(imp.source, analysis.filePath) !== null : importPath(ctx, imp.source, analysis.filePath)) continue;
        const project = packageProjectOf(imp.source, analysis.language, ctx);
        if (project && project !== analysis.projectId) set.add(project);
      }
    }
    ctx.importedProjectsCache.set(analysis.filePath, set);
  }
  return set;
}

const NO_FILES: ReadonlySet<string> = new Set();

/** The files declaring `pkg` in the language family `family` (`importsNamePackages`; index built on first use). */
function filesOfPackage(ctx: LinkContext, family: string | null, pkg: string): readonly string[] {
  if (!ctx.packageFiles) {
    ctx.packageFiles = new Map();
    for (const a of ctx.analyses) {
      if (!a.packageName || !manifestFor(a.language as Language)?.importsNamePackages) continue;
      const key = `${extensionFamily(a.filePath)}\0${a.packageName}`;
      const list = ctx.packageFiles.get(key);
      if (list) list.push(a.filePath);
      else ctx.packageFiles.set(key, [a.filePath]);
    }
  }
  return ctx.packageFiles.get(`${family}\0${pkg}`) ?? [];
}

/**
 * The files a package import names: the longest leading part that is a
 * declared package, narrowed to its files declaring the member named next
 * (`league.clubs.Club` → the files of `league.clubs` declaring `Club`; all of
 * them when none does — a type alias, a package object's member). Null when
 * no leading part is a package of the project.
 */
function packageImportFiles(ctx: LinkContext, family: string | null, segments: readonly string[]): readonly string[] | null {
  for (let i = segments.length; i > 0; i--) {
    const files = filesOfPackage(ctx, family, segments.slice(0, i).join("."));
    if (files.length === 0) continue;
    if (i === segments.length) return files;
    const member = segments[i]!;
    const declaring = files.filter((f) => ctx.symbolIndex.get(f)?.has(member));
    return declaring.length > 0 ? declaring : files;
  }
  return null;
}

/**
 * What a file sees by package, in a language whose imports name packages
 * (`importsNamePackages`): the files of its own package and of the packages
 * enclosing it, and those each import names — tried as written, then under
 * each enclosing package (a relative `import clubs.Club` inside `league`).
 * A production file never sees a test file this way.
 */
function packageScopeOf(analysis: FileAnalysis, ctx: LinkContext): ReadonlySet<string> {
  if (!manifestFor(analysis.language as Language)?.importsNamePackages) return NO_FILES;
  ctx.packageScopeCache ??= new Map();
  let set = ctx.packageScopeCache.get(analysis.filePath);
  if (set) return set;
  set = new Set();
  const family = extensionFamily(analysis.filePath);
  const isTest = packageTest(ctx, analysis.filePath);
  const own = analysis.packageName?.split(".") ?? [];
  const enclosing = own.map((_, i) => own.slice(0, own.length - i));
  const add = (files: readonly string[]) => {
    for (const f of files) if (f !== analysis.filePath && (isTest || !packageTest(ctx, f))) set!.add(f);
  };
  for (const pkg of enclosing) add(filesOfPackage(ctx, family, pkg.join(".")));
  for (const imp of analysis.imports) {
    const segments = imp.source.split(".").filter(Boolean);
    for (const prefix of [[], ...enclosing]) {
      const files = packageImportFiles(ctx, family, [...prefix, ...segments]);
      if (files) {
        add(files);
        break;
      }
    }
  }
  ctx.packageScopeCache.set(analysis.filePath, set);
  return set;
}

/** True when the analysis imports `file` — by path, by package, or by the package of the sub-project that holds it. */
function importsFile(analysis: FileAnalysis, file: string, ctx: LinkContext): boolean {
  if (importedFilesOf(analysis, ctx).has(file)) return true;
  if (packageScopeOf(analysis, ctx).has(file)) return true;
  const projects = importedProjectsOf(analysis, ctx);
  if (projects.size === 0) return false;
  const project = ctx.projectOf.get(file);
  return project !== undefined && projects.has(project);
}

/**
 * Whether `head` names a module whose free functions `head.fn()` calls: a name
 * an import binds (`import * as api from "./api"`, `import league.sql as sql`,
 * `from . import fixtures as fx`) — to the target's own file, a package or
 * barrel (`index`, `__init__`, `mod`) standing for it, or a sibling sub-project
 * the file imports by package — or a file loaded at run time where it is used
 * (`const heavy = await import("./post-edit.js")`). Never a builtin global, a
 * parameter, a local, nor an external package.
 */
function moduleReceiver(analysis: FileAnalysis, head: string, targetFile: string, ctx: LinkContext): boolean {
  if (packageScoped(analysis.language)) {
    // A Go import binds its package's name (or its alias): the target must lie in that directory.
    const imp = analysis.imports.find((i) => i.specifiers.includes(head));
    if (!imp) return false;
    const dir = ctx.importDirectory(imp.source, analysis.filePath);
    return dir !== null && targetFile.slice(0, Math.max(0, targetFile.lastIndexOf("/"))) === dir;
  }
  for (const imp of analysis.imports) {
    const resolved = importPath(ctx, imp.source, analysis.filePath);
    if (imp.specifiers.length === 0) {
      if (resolved === targetFile) return true;
      continue;
    }
    const binds = imp.specifiers.some((spec) => spec === head || spec.startsWith(head + ".")) || (!!imp.aliases && head in imp.aliases);
    if (!binds) continue;
    if (!resolved) {
      const project = ctx.projectOf.get(targetFile);
      if (project !== undefined && importedProjectsOf(analysis, ctx).has(project)) return true;
      continue;
    }
    if (resolved === targetFile) return true;
    if (/(?:^|\/)(?:index\.[^/]+|__init__\.pyi?|mod\.rs)$/.test(resolved)) return true;
  }
  return false;
}

/** Whether `head` is the name an import binds to a package no project directory holds (the standard library, a download). */
/**
 * A call chain (`c.Response()`, `httptest.NewRecorder()`) passing through a call no project
 * function, method or function-typed field bears. Right after an imported package the name
 * may also be a project type (`actions_model.RunList(runs)` converts); on a value it is a
 * method, which a type of that name is not.
 */
function callsOutside(segments: readonly string[], analysis: FileAnalysis, ctx: LinkContext): boolean {
  if (!ctx.callableNames) {
    ctx.callableNames = new Set();
    for (const a of ctx.analyses) {
      for (const f of a.functions ?? []) ctx.callableNames.add(f.name);
      for (const c of a.classes ?? []) {
        for (const m of c.methods ?? []) ctx.callableNames.add(m.name);
        for (const p of c.properties ?? []) if (/^func\b/.test(p.type ?? "")) ctx.callableNames.add(p.name);
      }
    }
  }
  const packageHead = segments.length > 1 && analysis.imports.some((i) => i.specifiers.includes(segments[0]!.trim()));
  return segments.some((segment, i) => {
    const open = segment.indexOf("(");
    if (i === 0 || open <= 0) return false;
    const name = segment.slice(0, open).trim();
    return !ctx.callableNames!.has(name) && !(i === 1 && packageHead && ctx.classCatalog.has(name));
  });
}

function headNamesForeignPackage(analysis: FileAnalysis, head: string, ctx: LinkContext): boolean {
  const imp = analysis.imports.find((i) => i.specifiers.includes(head));
  // Decided by the language's package rule only: a trailing-segment guess that finds no directory proves nothing.
  return !!imp && ctx.importDirectory.exact(imp.source, analysis.filePath) === null;
}

/**
 * The project file an import names: by the language's own rules where it has
 * them (`importedFile`: Dart `package:league/x.dart` → that package's
 * `lib/x.dart`, `'x.dart'` beside the importer; the SDK and downloads are no
 * file), else by the generic path rules.
 */
function importPath(ctx: LinkContext, source: string, fromFile: string): string | null {
  const language = ctx.languageOf.get(fromFile) as Language | undefined;
  const rule = language ? manifestFor(language)?.importedFile : undefined;
  if (rule) {
    let packages = ctx.packagesByLanguage.get(language!);
    if (!packages) ctx.packagesByLanguage.set(language!, (packages = packageEcosystemsFor(language!).flatMap((e) => ctx.packageRoots.get(e) ?? [])));
    const file = rule(fromFile, source, packages);
    if (file === null) return null;
    if (file !== undefined) return ctx.filePathMap.get(file) === file ? file : null;
  }
  return resolveTarget(source, fromFile, ctx.filePathMap);
}

/**
 * True when the analysis imports nothing the linker can see — by path or by
 * package. Never for a language whose loader states what a file reaches by
 * the constants it names (`autoloadedFiles`): naming none is evidence too.
 */
function importsNothing(analysis: FileAnalysis, ctx: LinkContext): boolean {
  if (manifestFor(analysis.language as Language)?.autoloadedFiles) return false;
  return importedFilesOf(analysis, ctx).size === 0 && importedProjectsOf(analysis, ctx).size === 0 && packageScopeOf(analysis, ctx).size === 0;
}

/**
 * Per ecosystem, the published package name of every sub-project (in the
 * ecosystem's own key form) → its id, so a package import can be followed to
 * the sub-project that is that package.
 */
function buildPackageProjectIndex(subProjects: readonly SubProject[]): Map<PackageEcosystem, Array<{ key: string; projectId: string }>> {
  const index = new Map<PackageEcosystem, Array<{ key: string; projectId: string }>>();
  for (const p of subProjects) {
    if (!p.packageName || !p.packageEcosystem) continue;
    const spec = packageMatchingFor(p.packageEcosystem);
    const key = spec?.packageKey?.(p.packageName) ?? p.packageName.toLowerCase();
    const list = index.get(p.packageEcosystem) ?? [];
    list.push({ key, projectId: p.id });
    index.set(p.packageEcosystem, list);
  }
  return index;
}

/**
 * The sub-project an import source names by declared package: the importer
 * language's ecosystems decide how the source is keyed (`importKey`) and
 * whether a longer path still names the package (`prefixMatch`) — the same
 * rules `dependency-inventory.ts` applies to third-party packages.
 */
function packageProjectOf(source: string, language: Language, ctx: LinkContext): string | null {
  let best: { key: string; projectId: string } | null = null;
  for (const ecosystem of packageEcosystemsFor(language)) {
    const candidates = ctx.packageProjects.get(ecosystem);
    if (!candidates) continue;
    const spec = packageMatchingFor(ecosystem);
    const key = spec?.importKey?.(source) ?? source.toLowerCase();
    if (!key) continue;
    const separator = spec?.prefixMatch?.separator;
    for (const c of candidates) {
      if ((key === c.key || (separator !== undefined && key.startsWith(c.key + separator))) && (!best || c.key.length > best.key.length)) best = c;
    }
  }
  return best?.projectId ?? null;
}

/** Stems of the files the analysis's imports resolve to — by path, or through an imported sub-project (cached). */
function importedStemsOf(analysis: FileAnalysis, ctx: LinkContext): Set<string> {
  let set = ctx.importedStemsCache.get(analysis.filePath);
  if (!set) {
    set = new Set();
    // A package import names a directory, never a file stem.
    if (!packageScoped(analysis.language)) for (const f of importedFilesOf(analysis, ctx)) set.add(fileStem(f));
    for (const project of importedProjectsOf(analysis, ctx)) for (const stem of projectStemsOf(project, ctx)) set.add(stem);
    ctx.importedStemsCache.set(analysis.filePath, set);
  }
  return set;
}

/** The file stems (names without directory or extension) of one sub-project, cached on the context. */
function projectStemsOf(projectId: string, ctx: LinkContext): Set<string> {
  let stems = ctx.projectStemsCache.get(projectId);
  if (!stems) {
    stems = new Set();
    for (const a of ctx.analyses) if (a.projectId === projectId) stems.add(fileStem(a.filePath));
    ctx.projectStemsCache.set(projectId, stems);
  }
  return stems;
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

/** See `LinkContext.dottedClassSuffixIndex`. */
function buildDottedClassSuffixIndex(analyses: FileAnalysis[]): Map<string, Array<{ file: string; name: string }>> {
  const idx = new Map<string, Array<{ file: string; name: string }>>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (!cls.name.includes(".")) continue;
      const segments = cls.name.split(".");
      for (let k = 0; k < segments.length; k++) {
        const suffix = segments.slice(k).join(".");
        const arr = idx.get(suffix);
        if (arr) arr.push({ file: a.filePath, name: cls.name });
        else idx.set(suffix, [{ file: a.filePath, name: cls.name }]);
      }
    }
  }
  return idx;
}

/**
 * The method a route declared at `line` names, when the line lies inside a class
 * that defines a method of that name (the innermost such class): `Class.method`.
 */
/** The innermost function or method whose body holds `line`, as its symbol (`Class.method`, `fn`). */
function callableAtLine(analysis: FileAnalysis, line: number): string | null {
  let best: { symbol: string; span: number } | null = null;
  const consider = (symbol: string, from: number, to: number | undefined) => {
    if (to === undefined || line <= from || line > to) return;
    if (!best || to - from < best.span) best = { symbol, span: to - from };
  };
  for (const fn of analysis.functions) consider(fn.name, fn.line, fn.endLine);
  for (const cls of analysis.classes) for (const m of cls.methods) consider(`${cls.name}.${m.name}`, m.line, m.endLine);
  return best ? (best as { symbol: string }).symbol : null;
}

function enclosingMethod(analysis: FileAnalysis, line: number, name: string): { symbol: string; line: number } | null {
  let best: { symbol: string; line: number; span: number } | null = null;
  for (const cls of analysis.classes) {
    if (line < cls.line || line > cls.endLine) continue;
    const method = cls.methods.find((m) => m.name === name);
    const span = cls.endLine - cls.line;
    if (method && (!best || span < best.span)) best = { symbol: `${cls.name}.${method.name}`, line: method.line, span };
  }
  return best && { symbol: best.symbol, line: best.line };
}

/**
 * A route handler written `Owner.Sub.action` whose owner is a dotted module
 * name: the method `action` of the ONE class (in the route's sub-project
 * first) whose dotted name ends in `Owner.Sub`. `resolveCallToDefinition`
 * reads a dotted name as receiver + member and never sees the module.
 */
function resolveDottedOwnerHandler(
  sourceFile: string,
  sourceSymbol: string,
  handler: string,
  line: number,
  analysis: FileAnalysis,
  ctx: LinkContext,
): SymbolLink | null {
  const m = /^([A-Z]\w*(?:\.[A-Z]\w*)*)\.([a-z_]\w*[?!]?)$/.exec(handler);
  if (!m) return null;
  const [, owner, method] = m;
  const candidates = ctx.dottedClassSuffixIndex.get(owner!) ?? [];
  if (candidates.length === 0) return null;
  const hits: Array<{ file: string; def: SymbolDef }> = [];
  for (const c of candidates) {
    const def = ctx.symbolIndex.get(c.file)?.get(`${c.name}.${method}`);
    if (def) hits.push({ file: c.file, def });
  }
  if (hits.length === 0) return null;
  const sameProject = hits.filter((h) => ctx.projectOf.get(h.file) === analysis.projectId);
  const chosen = sameProject.length === 1 ? sameProject[0]! : hits.length === 1 ? hits[0]! : null;
  if (!chosen) return null;
  return {
    sourceFile,
    sourceSymbol,
    sourceLine: line,
    callName: handler,
    targetFile: chosen.file,
    targetSymbol: chosen.def.name,
    targetLine: chosen.def.line,
    confidence: "INFERRED",
    strategy: "class-name",
    relation: relationForStrategy("class-name"),
  };
}

/** See `LinkContext.namespaceSuffixIndex`. */
function buildNamespaceSuffixIndex(
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): Map<string, Array<{ file: string; name: string }>> {
  const idx = new Map<string, Array<{ file: string; name: string }>>();
  for (const [filePath, syms] of symbolIndex) {
    for (const name of syms.keys()) {
      if (name.includes(".") || !name.includes("::")) continue;
      const segments = name.split("::");
      for (let k = 1; k < segments.length; k++) {
        const suffix = segments.slice(k).join("::");
        const arr = idx.get(suffix);
        if (arr) arr.push({ file: filePath, name });
        else idx.set(suffix, [{ file: filePath, name }]);
      }
    }
  }
  return idx;
}

/**
 * Build an inheritance map: className → { parentClass, parentFile }
 * Used to resolve inherited method calls.
 */
/**
 * The base class `className` (declared in `classFile`) extends, located the way
 * a type it names is (`locateClass`: its own import, sub-project, then a
 * definition unique in its type space) — never a same-named class of another
 * language family.
 */
function parentClassOf(ctx: LinkContext, className: string, classFile: string): { parentClass: string; parentFile: string } | null {
  const key = memberKey(classFile, className);
  const cache = (ctx.parentAt ??= new Map());
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const cls = ctx.classAt.get(key);
  // `Base<T>` / `Base[T]` names the class `Base`.
  const parent = cls?.extends ? bareClassName(cls.extends) : "";
  const parentFile = parent && parent !== className
    ? locateClass(ctx, parent, classFile, ctx.projectOf.get(classFile) ?? "root") ?? onlyConcrete(ctx, parent, cls?.kind === "interface", classFile)
    : null;
  const out = parentFile ? { parentClass: parent, parentFile } : null;
  cache.set(key, out);
  return out;
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
  /** The type as written, generic arguments kept (`IRepository<TModel>`). */
  written?: string;
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
function buildMemberTypes(analyses: FileAnalysis[], typeAliases: TypeAliasIndex | null = null): Map<string, Map<string, InjectionPoint>> {
  // Every definition of a class name (a name can recur across services/features).
  const classToFiles = new Map<string, string[]>();
  const declAt = new Map<string, FileAnalysis["classes"][number]>();
  const languageOfFile = new Map(analyses.map((a) => [a.filePath, a.language as string]));
  for (const a of analyses) {
    for (const cls of a.classes) {
      let arr = classToFiles.get(cls.name);
      if (!arr) classToFiles.set(cls.name, (arr = []));
      if (arr.length < CLASS_CANDIDATE_CAP && !arr.includes(a.filePath)) arr.push(a.filePath);
      declAt.set(memberKey(a.filePath, cls.name), cls);
    }
  }

  // A duplicated class name (microservice repos: a LicenseService per
  // service/feature) resolves to the definition closest to the CONSUMING file
  // by shared directory prefix; ambiguous ties resolve to nothing.
  // The consumer's own import of the type comes first: two same-named classes
  // in sibling namespaces (`Auth\AuthenticationService`, `Subsonic\…`) tie on
  // directory distance, and the `use` statement says which one is meant.
  const analysisOf = new Map(analyses.map((a) => [a.filePath, a]));
  let pathMap: Map<string, string> | null = null;
  const importedDecl = (typeName: string, consumerFile: string): string | null => {
    if ((classToFiles.get(typeName)?.length ?? 0) < 2) return null;
    const imps = analysisOf.get(consumerFile)?.imports.filter((i) => i.specifiers.includes(typeName) || i.source.split(/[\\/.:]+/).pop() === typeName) ?? [];
    for (const imp of imps) {
      pathMap ??= buildFilePathMap(analyses);
      const f = resolveTarget(imp.source, consumerFile, pathMap);
      if (f && declAt.has(memberKey(f, typeName))) return f;
    }
    return null;
  };
  // Only a declaration in the consumer's own type space: a Java field typed
  // `Club` never means a TypeScript `Club`.
  const inSpace = (files: readonly string[], consumerFile: string): string[] => {
    const lang = languageOfFile.get(consumerFile) ?? "";
    return files.filter((f) => sameTypeSpace(consumerFile, lang, f, languageOfFile.get(f) ?? ""));
  };
  const fileOf = (typeName: string, consumerFile: string): string | null =>
    importedDecl(typeName, consumerFile) ??
    pickDefinition(typeName, inSpace(classToFiles.get(typeName) ?? [], consumerFile), consumerFile, (f, n) => declAt.get(memberKey(f, n)), (f) => languageOfFile.get(f));

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
        const written = aliasedType(a, receiverTypeName(type, a.language));
        const typeName = written ? followTypeAlias(typeAliases, written, a.filePath, (n, near) => inSpace(classToFiles.get(n) ?? [], near).length > 0) : written;
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
        if (type && type.includes("<")) point.written = type;
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

      // Base classes as located from the class that names them (its import,
      // its directory, its type space) — never a same-named class elsewhere.
      const seen = new Set<string>([memberKey(a.filePath, cls.name)]);
      let base = bareClassName(cls.extends);
      let baseFile = base ? fileOf(base, a.filePath) : null;
      let child: FileAnalysis["classes"][number] | null = cls;
      while (base && baseFile && !seen.has(memberKey(baseFile, base))) {
        seen.add(memberKey(baseFile, base));
        const baseCls = declAt.get(memberKey(baseFile, base))!;
        for (const prop of baseCls.properties) add(prop.name, (child && handedType(child, baseCls, prop.name)) ?? prop.type, prop.qualifier, false);
        base = bareClassName(baseCls.extends);
        baseFile = base ? fileOf(base, baseFile) : null;
        child = null;
      }
      if (members.size > 0) out.set(memberKey(a.filePath, cls.name), members);
    }
  }

  // A computed member typed by the chain it returns (a Python `@property` returning
  // `self.repos.ingredient_foods`): the chain walked over the members typed above,
  // a few rounds so a chain through another computed member resolves too.
  const computed = analyses.flatMap((a) => a.classes.flatMap((cls) => cls.properties
    .filter((p) => p.from && !p.type)
    .map((prop) => ({ a, cls, prop }))));
  // Top-level functions by name → the classes their declared return type names (`fn()` heads).
  let returning: Map<string, Array<{ file: string; type: string }>> | null = null;
  const returnedClass = (fn: string, near: string): { name: string; file: string } | null => {
    if (!returning) {
      returning = new Map();
      for (const x of analyses) {
        for (const f of x.functions) {
          const type = receiverTypeName(f.returnType, x.language);
          if (type) (returning.get(f.name) ?? returning.set(f.name, []).get(f.name)!).push({ file: x.filePath, type });
        }
      }
    }
    const defs = (returning.get(fn) ?? []).filter((d) => sameTypeSpace(near, languageOfFile.get(near) ?? "", d.file, languageOfFile.get(d.file) ?? ""));
    if (defs.length !== 1) return null;
    const file = fileOf(defs[0]!.type, defs[0]!.file);
    return file ? { name: defs[0]!.type, file } : null;
  };
  const computedAt = new Set<string>();
  for (let round = 0; round < 3 && computed.length > 0; round++) {
    let progressed = false;
    for (const { a, cls, prop } of computed) {
      const key = memberKey(a.filePath, cls.name);
      const name = nameKey(a.language, prop.name);
      if (out.get(key)?.has(name)) continue;
      const segs = prop.from!.split(".");
      // A chain on a function's result (`get_repositories().recipes`): starts at the class it returns.
      const fnHead = /^(\w+)\(\)$/.exec(segs[0]!)?.[1];
      let cur: InjectionPoint | null;
      if (fnHead) {
        const returned = returnedClass(fnHead, a.filePath);
        if (!returned) continue;
        cur = { typeName: returned.name, typeFile: returned.file, member: "", consumer: cls.name };
      } else if (SELF_HEADS.has(segs[0]!)) {
        cur = { typeName: cls.name, typeFile: a.filePath, member: "", consumer: cls.name };
      } else continue;
      for (const seg of segs.slice(1)) {
        if (!cur?.typeFile) break;
        cur = out.get(memberKey(cur.typeFile, cur.typeName))?.get(nameKey(languageOfFile.get(cur.typeFile), seg)) ?? null;
      }
      if (!cur?.typeFile || !cur.typeName) continue;
      if (!out.has(key)) out.set(key, new Map());
      out.get(key)!.set(name, { typeName: cur.typeName, typeFile: cur.typeFile, member: prop.name, consumer: cls.name });
      computedAt.add(key);
      progressed = true;
    }
    if (!progressed) break;
  }
  // A computed member is its subclasses' too (`self.group_recipes` set in a base `__init__`).
  if (computedAt.size > 0) {
    for (const a of analyses) {
      for (const cls of a.classes) {
        const seen = new Set<string>([memberKey(a.filePath, cls.name)]);
        let base = bareClassName(cls.extends);
        let baseFile = base ? fileOf(base, a.filePath) : null;
        while (base && baseFile && !seen.has(memberKey(baseFile, base))) {
          const baseKey = memberKey(baseFile, base);
          seen.add(baseKey);
          if (computedAt.has(baseKey)) {
            const own = out.get(memberKey(a.filePath, cls.name)) ?? new Map<string, InjectionPoint>();
            for (const [n, point] of out.get(baseKey)!) if (!own.has(n)) own.set(n, { ...point, consumer: cls.name });
            out.set(memberKey(a.filePath, cls.name), own);
          }
          const baseCls = declAt.get(baseKey);
          base = bareClassName(baseCls?.extends);
          baseFile = base ? fileOf(base, baseFile) : null;
        }
      }
    }
  }
  return out;
}

/**
 * The type a subclass hands its base for a field the base sets from its
 * constructor: `BaseHandler(IRepository<T> repository) { _repository = repository; }`
 * and `MatchHandler(IMatchRepository matches) : base(matches)` make the
 * subclass's `_repository` an `IMatchRepository`. Null when any step is unstated.
 */
function handedType(child: ClassInfo, base: ClassInfo, field: string): string | null {
  const hole = (v: string | undefined): string | null => (v ? /^\$\{(\w+)\}$/.exec(v)?.[1] ?? null : null);
  const param = hole(base.fieldValues?.[field]);
  if (!param || !child.superArgs) return null;
  const index = base.methods.find((m) => isConstructor(m, base) && m.params.some((p) => p.name === param))?.params.findIndex((p) => p.name === param) ?? -1;
  const passed = index >= 0 ? hole(child.superArgs[index]) : null;
  if (!passed) return null;
  const ctor = child.methods.find((m) => isConstructor(m, child) && m.params.some((p) => p.name === passed));
  return ctor?.params.find((p) => p.name === passed)?.type ?? null;
}

/**
 * The type an alias import names (`using LocalClubs = League.Interfaces.IClubRepository;`,
 * Kotlin `import league.ClubRepository as Clubs`): the qualified source's last
 * segment, when the file imports the name as an alias of a type.
 */
function aliasedType(a: FileAnalysis, typeName: string | null): string | null {
  if (!typeName) return typeName;
  const imp = a.imports.find((i) => !i.isNamespace && i.specifiers.length === 1 && i.specifiers[0] === typeName && /^[\w.]+\.[A-Z]\w*$/.test(i.source));
  return imp ? imp.source.slice(imp.source.lastIndexOf(".") + 1) : typeName;
}

/** Key of a class within a file: `file\0className`. */
function memberKey(file: string, className: string): string {
  return `${file}\0${className}`;
}

/** A type as written → its bare class name: generics and namespace qualifiers dropped. */
function bareClassName(t: string | null | undefined): string {
  // `Base<T>`, and Python's `Base[T]` (`RepositoryGeneric[Schema, Model]`).
  return (t ?? "").replace(/[<[].*$/, "").trim().split(".").pop() ?? "";
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

/** Every class name → each declaration of it with the file analysis it lives in. */
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
 * The project interfaces class `name` implements, as the registering file
 * `reg` sees it: its definition in the same type space (the registering
 * sub-project first), every part of it when it is split across one directory
 * — and, as a container registers a class under every interface it has, the
 * ones its project base classes and base interfaces declare. A name defined in
 * several places, or a supertype outside the project (an external
 * `IDisposable`), contributes nothing.
 */
function declaredInterfaces(
  name: string,
  reg: FileAnalysis,
  decls: Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>>,
  seen = new Set<string>(),
): string[] {
  const inSpace = (d: { a: FileAnalysis }) => sameTypeSpace(reg.filePath, reg.language, d.a.filePath, d.a.language);
  const out = new Set<string>();
  seen.add(name);
  const cands = (decls.get(name) ?? []).filter(inSpace);
  const own = cands.filter((d) => d.a.projectId === reg.projectId);
  const pool = own.length > 0 ? own : cands;
  if (pool.length === 0 || new Set(pool.map((d) => d.a.filePath.slice(0, d.a.filePath.lastIndexOf("/") + 1))).size !== 1) return [];
  for (const d of pool) {
    for (const sup of declaredSupertypes(d.cls, d.a)) {
      const base = bareSupertypeName(sup);
      if (seen.has(base)) continue;
      if ((decls.get(base) ?? []).some((x) => x.cls.kind === "interface" && inSpace(x))) out.add(base);
      if (seen.size < MAX_BASE_DEPTH * 4) for (const inherited of declaredInterfaces(base, reg, decls, seen)) out.add(inherited);
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

  // A structural interface built from others (Go `type CObject interface { web.CRUDable;
  // web.Permissions }`, a Protocol over Protocols) has their methods too — when every one
  // it names is a structural interface of the analysis; otherwise its method set is not
  // all known, and matching part of it would accept types that do not satisfy it.
  const embedsOf = new Map<InterfaceImplInfo, string[]>();
  for (const a of analyses) {
    for (const cls of a.classes) {
      const entry = cls.kind === "interface" && cls.structural && cls.embeds?.length ? map.get(memberKey(a.filePath, cls.name)) : undefined;
      if (entry) embedsOf.set(entry, cls.embeds!.map(bareSupertypeName));
    }
  }
  const flattened = new Set<InterfaceImplInfo>();
  const flatten = (entry: InterfaceImplInfo, stack: Set<InterfaceImplInfo>): boolean => {
    const embeds = embedsOf.get(entry);
    if (!embeds || flattened.has(entry)) return entry.structural === true;
    if (stack.has(entry)) return false;
    stack.add(entry);
    const lang = languageOf.get(entry.interfaceFile) ?? "";
    for (const name of embeds) {
      const defs = (byName.get(name) ?? []).filter((d) => d !== entry && sameTypeSpace(entry.interfaceFile, lang, d.interfaceFile, languageOf.get(d.interfaceFile) ?? ""));
      const def = defs.length === 1 ? defs[0]! : null;
      if (!def || !def.structural || !flatten(def, stack)) {
        delete entry.structural;
        stack.delete(entry);
        return false;
      }
      for (const m of def.methods) if (!entry.methods.some((x) => x.name === m.name)) entry.methods.push({ ...m, inherited: true });
    }
    stack.delete(entry);
    flattened.add(entry);
    return true;
  };
  for (const entry of embedsOf.keys()) flatten(entry, new Set());

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
    // Promoted methods: a struct embedding an interface or another struct has their
    // methods too (`web.CRUDable` in `ProjectUser` gives it `ReadOne`), two levels deep.
    const embedsAt = new Map<string, { file: string; embeds: string[] }>();
    for (const a of analyses) {
      const scope = typesSpanFiles(a.language) ? a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1) : a.filePath;
      for (const cls of a.classes) {
        if (cls.kind !== "interface" && cls.embeds?.length) embedsAt.set(`${scope}\0${cls.name}`, { file: a.filePath, embeds: cls.embeds });
      }
    }
    for (let round = 0; round < 2 && embedsAt.size > 0; round++) {
      for (const [key, { file, embeds }] of embedsAt) {
        const set = methodSets.get(key);
        if (!set) continue;
        const lang = languageOf.get(file) ?? "";
        for (const name of embeds) {
          const ifaces = (byName.get(name) ?? []).filter((d) => sameTypeSpace(file, lang, d.interfaceFile, languageOf.get(d.interfaceFile) ?? ""));
          const structs = [...methodSets.entries()].filter(([k, s]) => s.name === name && k !== key && sameTypeSpace(file, lang, s.file, languageOf.get(s.file) ?? ""));
          const promoted = ifaces.length === 1
            ? ifaces[0]!.methods.map((m) => ({ name: m.name, line: m.line, arity: m.arity }))
            : structs.length === 1 ? [...structs[0]![1].methods.values()].map((m) => ({ ...m, arity: structs[0]![1].arity.get(m.name) })) : [];
          for (const m of promoted) {
            if (set.methods.has(m.name)) continue;
            set.methods.set(m.name, { name: m.name, line: m.line });
            if (m.arity !== undefined) set.arity.set(m.name, m.arity);
          }
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
  /**
   * `arity`: declared parameter count, which a structural implementation must match;
   * `inherited`: an embedded interface's method, declared there.
   */
  methods: { name: string; line: number; arity?: number; inherited?: true }[];
  impls: {
    className: string;
    classFile: string;
    methods: Map<string, { name: string; line: number }>;
  }[];
}

/**
 * Keys (`file\0symbol`) of every function and method declared with a receiver
 * parameter — Go methods, Kotlin/C# extension functions — under both the
 * bare and the `Class.method` spelling the symbol index uses.
 */
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

/** Every class name → the files declaring it, capped at `CLASS_FILES_CAP`. */
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

/** `file\0className` → the class declaration, for direct member lookups. */
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
  /** A name that REFERS to a callable (a route's handler), not a call written in a body. */
  reference = false,
): SymbolLink | null {
  const { filePathMap, symbolIndex, classCatalog, leafCatalog, classNameIndex } = ctx;

  // Split once: "userStore.fetchUsers" → head "userStore", leaf "fetchUsers"
  const parts = call.name.split(".");
  const isQualified = parts.length > 1;
  const leafName = parts[parts.length - 1]!;
  // Where members need `this.`/`self.`/`$this->` (JS/TS, Python, PHP), a bare
  // call in a body is a function — `redirect()` in a PHP controller is the
  // helper, never the controller's own `redirect` method.
  const bareIsFunction = !isQualified && !reference && pluginFor(analysis.language)?.explicitSelfMembers === true;

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

  // `function run(open) { open(); }` beside `import { startJournal as open }`: the
  // parameter is what the body calls, never the import it shadows.
  if (!isQualified && !reference && call.kind === "cross-file" && findEnclosingCallable(analysis, sourceSymbol)?.params.some((p) => p.name === call.name)) return null;

  if (call.kind === "cross-file" && call.target) {
    // Resolve import source to actual file path — by the language's own module rules when it has them (`crate::util`).
    const ownResolver = pluginFor(analysis.language)?.resolveImport;
    targetFile = ownResolver ? ownResolver(sourceFile, call.target, leafName, importResolveContext(ctx)) : resolveTarget(call.target, sourceFile, filePathMap);
    // An import naming a module by its DECLARED name rather than a path
    // (Elixir `alias MyApp.Accounts.User`): `User.get(…)` is that module's.
    if (!targetFile) {
      // `use function App\Support\money;` — the import names a function, not a file.
      const fn = !isQualified && call.target.includes("\\") ? namespacedFunction(ctx, analysis, [call.target.replace(/^\\/, "")]) : null;
      if (fn) return mkLink(fn.file, fn.def.name, fn.def.line, "EXTRACTED", "direct");
      return declaredModuleMember(ctx, analysis, call.target, parts, mkLink) ?? throughDeclaredType()
        ?? (parts.length === 2 ? aliasedClassMember(ctx, analysis, parts[0]!, leafName, mkLink) : null);
    }
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
  // Case folds only on a callable's own name — never on a receiver
  // (`handler.render` is not `Handler.render`).
  // `import { addPlayer as signPlayer }`: the call names the local alias, the module defines the export.
  // `const { remove: removeCar } = useGarage()`: the call names the local, the factory's module defines the member.
  const exported = !isQualified && call.kind === "cross-file" ? analysis.imports.find((i) => i.aliases?.[call.name])?.aliases?.[call.name] ?? call.member : undefined;
  let def = isQualified ? fileSymbols.get(call.name) : symbolIn(ctx, targetFile, exported ?? call.name);
  if (bareIsFunction && def?.name.includes(".")) def = undefined;
  // Which strategy found `def`. The default path at the bottom is reached from
  // two places — this plain lookup and Strategy 3's suffix match — and they were
  // previously distinguishable only by `linkConfidence`, which is a different
  // question. Whoever sets `def` sets this.
  let defStrategy: SymbolLinkStrategy = "direct";
  if (!def && !isQualified && !bareIsFunction) {
    def = symbolIn(ctx, targetFile, leafName);
  }
  // A barrel / package `__init__` that forwards the name (`export * from
  // "./x"`, `from .x import *`, `from .impl import Service`): the definition
  // is where the re-export leads. A named re-export stays the target only
  // when it leads nowhere in the project (a third-party package).
  if ((!def || def.reexport) && call.kind === "cross-file" && parts.length <= 2) {
    const head = parts[0]!;
    // `import * as utils from "./utils"; utils.format()` — the member by its own name.
    const viaNamespace = isQualified && analysis.imports.some((i) => i.isNamespace && i.specifiers.includes(head));
    const fwd = forwardedDefinition(ctx, targetFile, isQualified && !viaNamespace ? head : exported ?? leafName, 0, new Set());
    const member = fwd && isQualified && !viaNamespace ? symbolIn(ctx, fwd.file, `${head}.${leafName}`) : undefined;
    if (fwd && (!isQualified || viaNamespace || member)) {
      // A forwarded CLASS called by name is constructed (Strategy 5's link).
      const cls = member ? undefined : ctx.classAt.get(memberKey(fwd.file, fwd.def.name));
      if (cls) {
        const ctor = cls.methods.find((m) => CTOR_NAMES.has(m.name) || m.name === cls.name);
        return mkLink(fwd.file, ctor ? `${cls.name}.${ctor.name}` : cls.name, ctor?.line ?? cls.line, "INFERRED", "constructor");
      }
      targetFile = fwd.file;
      def = member ?? fwd.def;
    }
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
      // The ENCLOSING class's own member, else the one its bases provide —
      // not whichever class of the file happens to define the name first.
      const dot = sourceSymbol.indexOf(".");
      const consumer = dot > 0 && !sourceSymbol.startsWith("route:") ? sourceSymbol.slice(0, dot) : "";
      const hit = consumer && ctx.classAt.has(memberKey(sourceFile, consumer)) ? findMethodInClass(ctx, consumer, sourceFile, leafName) : null;
      if (hit && (hit.file !== sourceFile || !hit.symbol.startsWith(`${consumer}.`))) {
        return Object.assign(mkLink(hit.file, hit.symbol, hit.line, "INFERRED", "inheritance"), { viaType: consumer, viaTypeFile: sourceFile });
      }
      def = hit ? symbolIn(ctx, sourceFile, hit.symbol) : symbolIn(ctx, targetFile, leafName);
    }
  }

  // ── Strategy 1a: a bare `super` / `super(…)` ──
  // Re-dispatches the ENCLOSING method to the base class (Ruby/Crystal
  // `super`); inside a constructor it is the base class's constructor
  // (Java/JS/TS `super(…)`). Never anything else.
  // A `super(…)` that is only the receiver of a member call on the same line
  // (Python `super().save()`) is resolved through that member call instead.
  if (!def && call.kind === "internal" && call.name === "super") {
    const asReceiver = findEnclosingCallable(analysis, sourceSymbol)?.calls
      .some((c) => c.line === call.line && /^super\s*(?:\([^]*\))?\s*\./.test(c.name));
    return asReceiver ? null : superTarget(ctx, analysis, sourceFile, sourceSymbol, mkLink);
  }

  // ── Strategy 1: Inheritance resolution ──
  // If not found in current file and call is internal, walk up the class hierarchy.
  // Inherited methods are not explicitly named at the call site — INFERRED.
  // Only for a call on the instance itself — `foo()`, `this.foo()`,
  // `super.foo()`: `this.repo.find()` calls the FIELD's `find`, and a base
  // class's own `find` must not capture it (Strategy 2 follows the field).
  const onSelf = (!isQualified && !bareIsFunction) || (parts.length === 2 && (SELF_HEADS.has(parts[0]!) || SUPER_HEADS.has(parts[0]!.replace(/\(.*\)$/, ""))));
  if (!def && call.kind === "internal" && onSelf) {
    const currentClasses = analysis.classes;
    for (const cls of currentClasses) {
      let parentInfo = parentClassOf(ctx, cls.name, sourceFile);
      const visited = new Set<string>();
      while (parentInfo && !visited.has(memberKey(parentInfo.parentFile, parentInfo.parentClass))) {
        visited.add(memberKey(parentInfo.parentFile, parentInfo.parentClass));
        const parentSymbols = symbolIndex.get(parentInfo.parentFile);
        if (parentSymbols) {
          const parentDef = symbolIn(ctx, parentInfo.parentFile, leafName)
            ?? symbolIn(ctx, parentInfo.parentFile, `${parentInfo.parentClass}.${leafName}`);
          if (parentDef) {
            const link = mkLink(parentInfo.parentFile, parentDef.name, parentDef.line, "INFERRED", "inheritance");
            // Called on the enclosing class's own instance: say which (see `SymbolLink.viaType`).
            if (sourceSymbol.startsWith(`${cls.name}.`)) Object.assign(link, { viaType: cls.name, viaTypeFile: sourceFile });
            return link;
          }
        }
        // Walk further up the chain
        parentInfo = parentClassOf(ctx, parentInfo.parentClass, parentInfo.parentFile);
      }
    }
    // A method the class takes from a module/trait it mixes in (Ruby
    // `include Helper`, PHP `use Trait`, a default interface method). Where
    // members need `this.`/`self.`, a bare name is never one of them.
    const mixed = isQualified || !pluginFor(analysis.language)?.explicitSelfMembers
      ? mixinMember(ctx, analysis, sourceFile, sourceSymbol, leafName)
      : null;
    if (mixed) return mkLink(mixed.file, mixed.symbol, mixed.line, "INFERRED", "inheritance");
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

  // ── Strategy 3a: an imported class/instance's inherited member ──
  // `MonitorsAPI.update(id)` where './monitors' declares `class MonitorsAPI
  // extends ApiClient` (and exports its instance) without its own `update`:
  // the member is the base class's.
  // The binding may name the module's exported instance rather than its class:
  // `import AgentAPI from './agents'` where './agents' ends `export default new Agents()`.
  const instanceClass = (): string | undefined => {
    if (!targetFile || ctx.classAt.has(memberKey(targetFile, parts[0]!))) return parts[0];
    const imported = analysis.imports.find((i) => i.isDefault && i.specifiers[0] === parts[0]);
    if (!imported) return undefined;
    const target = (ctx.analysisAt ??= new Map(ctx.analyses.map((a) => [a.filePath, a]))).get(targetFile);
    const cls = target?.exports.find((e) => e.kind === "default")?.instanceOf;
    return cls && ctx.classAt.has(memberKey(targetFile, cls)) ? cls : undefined;
  };
  const headClass = !def && call.kind === "cross-file" && isQualified && parts.length === 2 && targetFile ? instanceClass() : undefined;
  if (headClass) {
    const inherited = findMethodInClass(ctx, headClass, targetFile!, leafName);
    if (inherited) {
      const link = mkLink(inherited.file, inherited.symbol, inherited.line, "INFERRED", "inheritance");
      if (!inherited.symbol.startsWith(`${headClass}.`)) Object.assign(link, { viaType: headClass, viaTypeFile: targetFile });
      return link;
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
    // A barrel forwarding the factory (`export * from "./use-club-store"`,
    // `export { useClubStore } from …`): the factory is where the re-export
    // leads, not the barrel's line.
    const fwd = !viaDef || viaDef.reexport ? forwardedDefinition(ctx, targetFile, call.via, 0, new Set()) : null;
    // What the factory returns is often its own nested function (`const { fetchPage } = useClubs()`
    // through a barrel, `clubs.fetchPage()`): that function, not the factory.
    const member = !isQualified ? exported ?? call.name : parts.length === 2 ? leafName : null;
    const factory = fwd ? { file: fwd.file, def: fwd.def } : viaDef ? { file: targetFile, def: viaDef } : null;
    if (member && factory) {
      const inner = (ctx.analysisAt ??= new Map(ctx.analyses.map((a) => [a.filePath, a]))).get(factory.file)?.functions
        .filter((f) => f.name === member && f.line > factory.def.line && f.endLine <= factory.def.endLine);
      if (inner?.length === 1) return mkLink(factory.file, inner[0]!.name, inner[0]!.line, "INFERRED", "direct");
    }
    if (fwd) return mkLink(fwd.file, fwd.def.name, fwd.def.line, "INFERRED", "factory-via");
    if (viaDef) {
      return mkLink(targetFile, viaDef.name, viaDef.line, "INFERRED", "factory-via");
    }
  }

  // ── Strategy 3c: a call on a module written out by its declared name ──
  // `MyApp.Accounts.User.get(…)`: the longest dotted prefix some file declares
  // as a module/class is the receiver.
  if (!def && isQualified && parts.length >= 3) {
    for (let k = parts.length - 1; k >= 2; k--) {
      const link = declaredModuleMember(ctx, analysis, parts.slice(0, k).join("."), [parts.slice(0, k).join("."), ...parts.slice(k)], mkLink);
      if (link) return link;
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
    let candidateFiles = classNameIndex.get(className);
    let declaredClass = className;
    // A type alias called on (`using ScoreCalc = League.Scoring.Calc;` … `ScoreCalc.Add(1, 2)`).
    if (!candidateFiles && ctx.typeAliases) {
      const target = dealias(ctx, className, sourceFile);
      if (target !== className && classNameIndex.has(target)) {
        candidateFiles = classNameIndex.get(target);
        declaredClass = target;
      }
    }
    // A namespace written relative to the caller's (`Routes::Misc.home`
    // inside `module Invidious`, a Rails `Users::Create` under `Admin`)
    // names the ONE class whose declared name ends that way; two such
    // classes are a lookup the linker cannot decide, so neither is taken.
    if (!candidateFiles) {
      const matches = ctx.namespaceSuffixIndex.get(className);
      if (matches && new Set(matches.map((m) => m.name)).size === 1) {
        candidateFiles = matches.map((m) => m.file);
        declaredClass = matches[0]!.name;
      }
    }
    // A dotted module called by its trailing names (`QueryBuilder.build` for
    // `League.Stats.SQL.QueryBuilder`, aliased through `alias League.Stats.SQL`):
    // the one module ending that way, or the one under a module the file imports.
    if (!candidateFiles) {
      let matches = ctx.dottedClassSuffixIndex.get(className) ?? [];
      if (new Set(matches.map((m) => m.name)).size > 1) {
        const prefixes = analysis.imports.map((i) => i.source + ".");
        matches = matches.filter((m) => prefixes.some((p) => m.name.startsWith(p)));
      }
      if (matches.length > 0 && new Set(matches.map((m) => m.name)).size === 1) {
        candidateFiles = matches.map((m) => m.file);
        declaredClass = matches[0]!.name;
      }
    }
    // `P19LogHelper::P19Logger.log` where the class is declared NESTED —
    // `module P19LogHelper` … `class P19Logger` — under its simple name.
    if (!candidateFiles && className.includes("::")) {
      const segments = className.split("::");
      const inner = segments[segments.length - 1]!;
      const outer = segments[segments.length - 2]!;
      const nested = (classNameIndex.get(inner) ?? []).filter((f) => {
        const o = ctx.classAt.get(memberKey(f, outer));
        const i = ctx.classAt.get(memberKey(f, inner));
        return !!o && !!i && o.line < i.line && i.endLine <= o.endLine;
      });
      if (nested.length > 0) {
        candidateFiles = nested;
        declaredClass = inner;
      }
    }
    if (candidateFiles) {
      const sameProject = candidateFiles
        .filter((f) => ctx.projectOf.get(f) === analysis.projectId)
        .sort(
          (x, y) =>
            commonPrefixLength(y, sourceFile) - commonPrefixLength(x, sourceFile),
        );
      const imported = candidateFiles.filter((f) => ctx.projectOf.get(f) !== analysis.projectId && importsFile(analysis, f, ctx));
      // A type whose parts span files (a Rust struct in `source/x.rs`, its `impl`
      // in `impls/x.rs`): the parts beside an imported one, in its sub-project.
      const importedProjects = new Set(imported.filter((f) => typesSpanFiles(ctx.languageOf.get(f))).map((f) => ctx.projectOf.get(f)));
      const eligible =
        sameProject.length === candidateFiles.length
          ? sameProject
          : [
              ...sameProject,
              ...imported,
              ...candidateFiles.filter((f) => !imported.includes(f) && ctx.projectOf.get(f) !== analysis.projectId && importedProjects.has(ctx.projectOf.get(f))),
            ];
      for (const filePath of eligible) {
        const syms = symbolIndex.get(filePath)!;
        // A call on the class itself reaches its class-level method when the
        // language names one apart (Ruby `def self.call` → `X.self.call`).
        // Bare, only where the name IS a class of that file (a member it lists bare): a local
        // that merely shares a name with some symbol there (`text.count`, `entry.get`) reaches nothing.
        // The bare entry counts only inside the class's own body: a free
        // function beside the class (or another class's member) is not its member.
        const cls = ctx.classAt.get(memberKey(filePath, declaredClass));
        const bare = cls ? syms.get(methodName) : undefined;
        const classDef = syms.get(`${declaredClass}.self.${methodName}`) ?? syms.get(`${declaredClass}.${methodName}`) ??
          (bare && bare.line >= cls!.line && bare.line <= cls!.endLine ? bare : undefined);
        if (classDef) {
          return mkLink(filePath, classDef.name, classDef.line, "INFERRED", "class-name");
        }
      }
      // A class-level member the class takes from its base (`Match.find()` on `class Match extends Model`).
      if (!methodName.includes(".")) {
        for (const filePath of eligible) {
          if (!ctx.classAt.has(memberKey(filePath, declaredClass))) continue;
          const inherited = findMethodInClass(ctx, declaredClass, filePath, methodName);
          if (!inherited) break;
          const link = mkLink(inherited.file, inherited.symbol, inherited.line, "INFERRED", "inheritance");
          if (!inherited.symbol.startsWith(`${declaredClass}.`)) Object.assign(link, { viaType: declaredClass, viaTypeFile: filePath });
          return link;
        }
      }
      // `TfrmPlayers.Create(AOwner)` / `Foo.new` — the language constructs
      // through a class-level call the class does not declare by that name.
      if (constructorCallsOf(analysis.language).some((c) => nameKey(analysis.language, c) === nameKey(analysis.language, methodName))) {
        for (const filePath of eligible) {
          const cls = ctx.classAt.get(memberKey(filePath, declaredClass));
          if (!cls || isDesignFormat(ctx.languageOf.get(filePath))) continue;
          const ctor = cls.methods.find((m) => isConstructor(m, cls));
          const d = ctor ? symbolIn(ctx, filePath, `${declaredClass}.${ctor.name}`) : undefined;
          return mkLink(filePath, d?.name ?? declaredClass, d?.line ?? cls.line, "INFERRED", "constructor");
        }
      }
    }
  }

  // ── Strategy 5: Constructor resolution ──
  // `new User` (TS/C#/Java), `New User` (VB) — and VB-style bare `UserEditForm(...)`
  // — where the class lives in another file. Same-namespace languages need no
  // import at the call site, so resolve via the (unique) global class name.
  if (!def) {
    // `new App\Invoice` qualifies with PHP's `\` as `new a.b.C` does with `.`.
    const ctorMatch = call.name.match(/^[Nn]ew\s+\\?([\w.\\]+)$/);
    const className = ctorMatch
      ? ctorMatch[1]!.split(/[.\\]/).pop()!
      : !isQualified
        ? call.name
        : null;
    if (className) {
      const entry = classEntryFor(classCatalog.get(className), sourceFile);
      // A constructor of a globally-unique type is unambiguous even across
      // sub-projects (`new GetRoleHoldersQuery()` in Api → its record in
      // Application), so allow cross-project resolution here.
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId, { allowCrossProject: true }) && !unboundAcrossModules(ctx, analysis, className, entry.file)) {
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
    // The one directory the import names, when the language's package rule
    // decides it (a Go import by its go.mod module path): the symbol is that
    // package's, or no project file's — the standard library, a download.
    const exactDir = imp && packageScoped(analysis.language) ? ctx.importDirectory.exact(imp.source, sourceFile) : undefined;
    if (imp && exactDir !== undefined) {
      if (exactDir !== null) {
        let found: { file: string; def: SymbolDef } | null = null;
        let count = 0;
        for (const filePath of packageFilesOf(ctx, exactDir, sourceFile)) {
          const d = symbolIndex.get(filePath)?.get(leafName);
          if (d) {
            count++;
            if (count > 1) break;
            found = { file: filePath, def: d };
          }
        }
        if (count === 1 && found) return mkLink(found.file, found.def.name, found.def.line, "INFERRED", "import-dir");
      }
    } else if (imp) {
      const impFile = importPath(ctx, imp.source, sourceFile);
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

  // ── Strategy 6a: a function by its namespace-qualified name ──
  // PHP looks `money()` up in the file's own namespace, then the global one;
  // `\App\money()` is absolute and `Sub\money()` relative to the namespace.
  if (!def && !isQualified && call.kind === "internal" && (analysis.declaredNamespace || call.name.includes("\\"))) {
    const ns = analysis.declaredNamespace;
    const name = call.name;
    const candidates = name.startsWith("\\")
      ? [name.slice(1)]
      : name.includes("\\")
        ? [ns ? `${ns}\\${name}` : name]
        : ns ? [`${ns}\\${name}`, name] : [name];
    const fn = namespacedFunction(ctx, analysis, candidates);
    if (fn && !(fn.file === sourceFile && fn.def.name === sourceSymbol)) {
      return mkLink(fn.file, fn.def.name, fn.def.line, fn.file === sourceFile ? "EXTRACTED" : "INFERRED", "direct");
    }
  }

  // ── Strategy 6b: a bare call into a file whose import shares its scope ──
  // Dot-sourcing / `Import-Module` (PowerShell), `source` (Bash) put the other
  // file's top-level functions in scope without naming them: `Write-Log "x"`
  // after `. ./lib/Common.ps1` is Common's `Write-Log`. Only for languages
  // that say so (`importsShareScope`) — a JS or Python module's names are in
  // scope only when imported by name — or by a wildcard (`from .jobs import *`),
  // which brings in what the module exports. Exactly one imported file may define it.
  const sharesScope = importsShareScope(analysis.language);
  if (!def && !isQualified && call.kind === "internal" && (sharesScope || analysis.imports.some(isWildcardImport))) {
    const hits = new Map<string, SymbolDef>();
    for (const imp of analysis.imports) {
      // A script it RUNS shares no names with it.
      if (imp.executes) continue;
      const wildcard = isWildcardImport(imp);
      if (!sharesScope && !wildcard) continue;
      const impFile = importPath(ctx, imp.source, sourceFile);
      if (!impFile || impFile === sourceFile || hits.has(impFile)) continue;
      const d = symbolIn(ctx, impFile, call.name);
      if (!d || d.name.includes(".")) continue;
      if (wildcard && !sharesScope) {
        ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
        if (!starForwards(ctx.analysisByFile.get(impFile), d.name)) continue;
      }
      hits.set(impFile, d);
    }
    if (hits.size === 1) {
      const [[file, d]] = [...hits];
      return mkLink(file!, d!.name, d!.line, "INFERRED", "import-file");
    }
  }

  // ── Strategy 6c: a bare call into the caller's package directory ──
  // Go's package is its directory: `normalizeEmbedding(e)` in embeddings.go is
  // the function embedding.go declares, no import involved. The compiler
  // forbids a second declaration, so one non-test hit is the definition.
  if (!def && !isQualified && call.kind === "internal" && pluginFor(analysis.language)?.directoryScope) {
    const hit = directoryFunction(ctx, analysis, sourceFile, call.name);
    if (hit) return mkLink(hit.file, hit.def.name, hit.def.line, "EXTRACTED", "direct");
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
        // `SponsorEntity.setStartDate` however unique that setter is. (If the
        // declared type HAD resolved to a file defining the method, Strategy 2
        // would have linked it before reaching here.)
        // The call's own statement of its receiver (`Printexc.to_string` on
        // the OCaml module `Printexc`, a container lookup) counts first.
        // A builtin one (`String`) normalizes to nothing, and contradicts any
        // app class all the more: it is kept as written.
        const declared = (call.receiverType ? receiverTypeName(call.receiverType, analysis.language) || call.receiverType : null)
          ?? receiverDeclaredType(analysis, sourceSymbol, head.replace(/\?$/, ""));
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
        // Where locals carry no declared type, the receiver's own name may state
        // its class, or end it (`match_report.close!` → `MatchReport`,
        // `api.addScore` on a `ScoreApi`).
        const namedType = tgtClass ? manifestFor(analysis.language as Language)?.typeNamedByReceiver?.(head.replace(/\?$/, "")) : null;
        const evidenced =
          sameDir ||
          importsFile(analysis, entry.file, ctx) ||
          importedStemsOf(analysis, ctx).has(fileStem(entry.file)) ||
          (!!namedType && tgtClass!.split(/::|\./).pop()!.endsWith(namedType));
        // A free function is reached through a receiver only when the receiver
        // is its module: `Math.round`, `monkeypatch.setattr` or a `path` local's
        // `read_bytes` never call the project's `round` / `setattr` / `read_bytes`.
        const freeTargetVetoed = tgtClass === null && !moduleReceiver(analysis, head.replace(/\?$/, ""), entry.file, ctx);
        // A receiver that is itself a call's result (`time.Unix().In`) has a type
        // only its declared return could say; Strategy 2 followed that and failed,
        // so a match by name alone needs the target to be in scope.
        const callReceiver = parts.slice(1, -1).some((p) => p.includes("("));
        // A receiver that is a package no project directory holds (`strings.Cut`,
        // `builder.Select().From` on an imported query builder): its values are
        // that package's types, never a project method of the same name.
        const foreignPackage = packageScoped(analysis.language) && headNamesForeignPackage(analysis, head.replace(/\?$/, ""), ctx);
        // Where a method belongs to its package, a value another module made is never a project
        // value: a chain through a call no project file defines (`c.Response().Header` on a web
        // framework's context), or a local initialized by a foreign package's function or by
        // such a call (`rec := httptest.NewRecorder()`, `resp := (*c).Response()`).
        const foreignValue = packageScoped(analysis.language) && (
          callsOutside(parts.slice(0, -1), analysis, ctx) ||
          (findEnclosingCallable(analysis, sourceSymbol)?.localTypes ?? []).some((l) => {
            const from = l.name === head ? l.from?.split(".") : undefined;
            return !!from && from.length > 1 &&
              ((from.length === 2 && headNamesForeignPackage(analysis, from[0]!, ctx)) || callsOutside(from, analysis, ctx));
          }));
        if (!contradicted && !freeTargetVetoed && !foreignPackage && !foreignValue && (evidenced || (!callReceiver && importsNothing(analysis, ctx)))) {
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
      if (entry && isSafeHeuristicTarget(entry, sourceFile, analysis.projectId, { allowCrossProject: true }) && !unboundAcrossModules(ctx, analysis, typeName, entry.file)) {
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

/** Longest chain of re-exports followed to a definition. */
const MAX_REEXPORT_DEPTH = 5;

/**
 * The top-level definition of `name` that `file` forwards through its
 * re-exports (`export { x } from "./x"`, `export * from "./x"`, Python
 * `from .x import *`), followed through further barrels. Two re-exports
 * leading to different definitions decide nothing.
 */
function forwardedDefinition(
  ctx: LinkContext,
  file: string,
  name: string,
  depth: number,
  seen: Set<string>,
): { file: string; def: SymbolDef } | null {
  if (depth > MAX_REEXPORT_DEPTH || seen.has(file)) return null;
  seen.add(file);
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  const exports = ctx.analysisByFile.get(file)?.exports ?? [];
  let found: { file: string; def: SymbolDef } | null = null;
  for (const e of exports) {
    if (e.kind !== "re-export" || !e.source || (e.name !== name && e.name !== "*")) continue;
    const inner = e.name === "*" ? name : e.sourceName ?? name;
    const target = resolveTarget(e.source, file, ctx.filePathMap);
    if (!target || target === file) continue;
    const d = symbolIn(ctx, target, inner);
    // `export *` / `from m import *` forwards what the target EXPORTS: not a
    // Python `_private` name, nor one its `__all__` leaves out. A module that
    // declares no exports at all (CommonJS) still forwards its definitions.
    const forwards = e.name !== "*" || starForwards(ctx.analysisByFile.get(target), inner);
    const hit = forwards && d && d.name === inner ? { file: target, def: d } : forwardedDefinition(ctx, target, inner, depth + 1, seen);
    if (!hit) continue;
    if (found && (found.file !== hit.file || found.def.name !== hit.def.name)) return null;
    found = hit;
  }
  return found;
}

/**
 * The one free function a namespace-qualified name (`App\Support\money`)
 * names, among files of the caller's language that declare namespaces —
 * candidates tried in order, the first that names any decides; two
 * definitions of one name decide nothing.
 */
function namespacedFunction(
  ctx: LinkContext,
  analysis: FileAnalysis,
  candidates: readonly string[],
): { file: string; def: SymbolDef } | null {
  if (!ctx.namespacedFunctions) {
    const index = new Map<string, Array<{ file: string; def: SymbolDef }>>();
    const languages = new Set(ctx.analyses.filter((a) => a.declaredNamespace).map((a) => a.language));
    for (const a of ctx.analyses) {
      if (!languages.has(a.language)) continue;
      const symbols = ctx.symbolIndex.get(a.filePath);
      for (const fn of a.functions) {
        if (fn.name === "<setup>" || fn.name.includes(".")) continue;
        const def = symbols?.get(fn.name);
        if (!def) continue;
        const key = `${a.language}\0${(a.declaredNamespace ? `${a.declaredNamespace}\\${fn.name}` : fn.name).toLowerCase()}`;
        const list = index.get(key);
        if (list) list.push({ file: a.filePath, def });
        else index.set(key, [{ file: a.filePath, def }]);
      }
    }
    ctx.namespacedFunctions = index;
  }
  for (const c of candidates) {
    const hits = ctx.namespacedFunctions.get(`${analysis.language}\0${c.toLowerCase()}`);
    if (hits) return hits.length === 1 ? hits[0]! : null;
  }
  return null;
}

/** `from m import *` — every exported name, none spelled out. */
function isWildcardImport(imp: { isNamespace: boolean; specifiers: readonly string[] }): boolean {
  return imp.isNamespace && imp.specifiers.length === 0;
}

/** Whether a star re-export of `file` carries `name`: one of its own exports, or anything when it declares none. */
function starForwards(target: FileAnalysis | undefined, name: string): boolean {
  const own = (target?.exports ?? []).filter((x) => x.kind !== "re-export");
  return own.length === 0 || own.some((x) => x.name === name);
}

/**
 * `Head.member` where `Head` stands for the module/class DECLARED as `module`
 * (exactly that name — `MyApp.Accounts.User`) by one file of the caller's
 * type space, its own sub-project first.
 */
function declaredModuleMember(
  ctx: LinkContext,
  analysis: FileAnalysis,
  module: string,
  parts: string[],
  mkLink: MkLink,
): SymbolLink | null {
  if (parts.length !== 2 || !module.includes(".")) return null;
  const files = (ctx.classFiles.get(module) ?? []).filter((f) =>
    sameTypeSpace(analysis.filePath, analysis.language, f, ctx.languageOf.get(f) ?? ""),
  );
  const own = files.filter((f) => ctx.projectOf.get(f) === analysis.projectId);
  const pool = own.length > 0 ? own : files;
  if (pool.length !== 1) return null;
  const hit = findMethodInClass(ctx, module, pool[0]!, receiverSegment(parts[1]!));
  return hit ? mkLink(hit.file, hit.symbol, hit.line, "EXTRACTED", "import-file") : null;
}

/**
 * Where a bare `super` in `sourceSymbol` (`Class.method`) goes: the base
 * class's (own or inherited) method of the same name — or, from a
 * constructor, the base class's constructor.
 */
function superTarget(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  mkLink: MkLink,
): SymbolLink | null {
  const dot = sourceSymbol.indexOf(".");
  if (dot <= 0) return null;
  const consumer = sourceSymbol.slice(0, dot);
  const methodName = sourceSymbol.slice(dot + 1);
  const cls = ctx.classAt.get(memberKey(sourceFile, consumer));
  const base = bareClassName(cls?.extends);
  if (!cls || !base) return null;
  const baseFile = locateClass(ctx, base, sourceFile, analysis.projectId);
  if (!baseFile) return null;
  const method = cls.methods.find((m) => m.name === methodName);
  const names = method && isConstructor(method, cls) ? [...CTOR_NAMES, "init", "initialize", base] : [methodName];
  for (const name of names) {
    const hit = findMethodInClass(ctx, base, baseFile, name);
    if (hit) return mkLink(hit.file, hit.symbol, hit.line, "INFERRED", "inheritance");
  }
  return null;
}

/**
 * The one module/trait/interface the enclosing class (or a base class)
 * declares as a supertype that defines `method` — what a bare call reaches
 * when neither the class nor its base chain defines it. Two that do: none.
 */
function mixinMember(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  method: string,
): { file: string; symbol: string; line: number } | null {
  const dot = sourceSymbol.indexOf(".");
  if (dot <= 0 || sourceSymbol.startsWith("route:")) return null;
  let name = sourceSymbol.slice(0, dot);
  let file: string | null = sourceFile;
  const found = new Map<string, { file: string; symbol: string; line: number }>();
  const seen = new Set<string>();
  for (let depth = 0; file && depth < MAX_BASE_DEPTH; depth++) {
    const key = memberKey(file, name);
    if (seen.has(key)) break;
    seen.add(key);
    const cls = ctx.classAt.get(key);
    if (!cls) break;
    const supertypes = depth === 0 ? declaredSupertypes(cls, analysis) : cls.implements;
    for (const raw of supertypes) {
      const mixin = bareClassName(raw);
      if (!mixin || mixin === bareClassName(cls.extends)) continue;
      const mixinFile = locateClass(ctx, mixin, file, ctx.projectOf.get(file) ?? "root");
      const hit = mixinFile ? findMethodInClass(ctx, mixin, mixinFile, method) : null;
      if (hit) found.set(`${hit.file}\0${hit.symbol}`, hit);
    }
    const base = bareClassName(cls.extends);
    if (!base) break;
    file = locateClass(ctx, base, file, ctx.projectOf.get(file) ?? "root");
    name = base;
  }
  return found.size === 1 ? [...found.values()][0]! : null;
}

/**
 * The top-level function `name` declared by exactly one other file of
 * `sourceFile`'s directory in its language family — never a test file for
 * production code.
 */
function directoryFunction(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  name: string,
): { file: string; def: SymbolDef } | null {
  const dir = sourceFile.slice(0, sourceFile.lastIndexOf("/") + 1);
  ctx.directoryFiles ??= filesByDirectory(ctx.analyses);
  const sourceIsTest = isTestFile(sourceFile, analysis.language);
  const family = extensionFamily(sourceFile);
  let found: { file: string; def: SymbolDef } | null = null;
  for (const file of ctx.directoryFiles.get(dir) ?? []) {
    if (file === sourceFile || extensionFamily(file) !== family) continue;
    if (!sourceIsTest && isTestFile(file, (ctx.languageOf.get(file) ?? analysis.language) as Language)) continue;
    const def = symbolIn(ctx, file, name);
    if (!def || def.name.includes(".")) continue;
    if (found) return null;
    found = { file, def };
  }
  return found;
}

/** Every directory (with trailing slash) → the files directly inside it. */
function filesByDirectory(analyses: FileAnalysis[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of analyses) {
    const dir = a.filePath.slice(0, a.filePath.lastIndexOf("/") + 1);
    const list = out.get(dir);
    if (list) list.push(a.filePath);
    else out.set(dir, [a.filePath]);
  }
  return out;
}

/** Longest receiver chain followed through member and return types (`this.a.b.c.m()`, `a.getB().getC().m()`). */
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
    let typeName = receiverTypeName(call.receiverType, analysis.language);
    if (!typeName && !call.receiverQualifier) return null;
    if (typeName) typeName = dealias(ctx, typeName, sourceFile);
    let typeFile = typeName ? typeFileFor(ctx, typeName, sourceFile, analysis.projectId) : null;
    // A language that names a class by its qualified path (`Billing::InvoiceService`)
    // declares it under that name, which the bare name does not find.
    const written = call.receiverType?.trim().replace(/^::/, "");
    if (typeName && !typeFile && written && written !== typeName && /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+$/.test(written)) {
      const qualified = typeFileFor(ctx, written, sourceFile, analysis.projectId);
      if (qualified) { typeName = written; typeFile = qualified; }
    }
    const point: InjectionPoint = {
      typeName: typeName ?? "",
      typeFile,
      member: "",
      consumer,
    };
    if (call.receiverQualifier) point.qualifier = call.receiverQualifier;
    return linkThroughPoint(ctx, analysis, sourceFile, point, leafName, mkLink);
  }

  const receiver = receiverChain(call.name);
  if (!receiver || receiver.length === 0 || receiver.length > MAX_RECEIVER_CHAIN + 1) return null;
  const point = chainPoint(ctx, analysis, sourceFile, sourceSymbol, consumer, receiver, 0, false);
  if (!point) return null;
  return linkThroughPoint(ctx, analysis, sourceFile, point, leafName, mkLink);
}

/**
 * Where a receiver chain ends: its head as the enclosing callable scopes it
 * (or a constructed instance, an own method's result, a project class), then
 * each further segment as a member of the previous one's class — a field
 * through its declared type, a call through its declared return type.
 * `depth` counts the initializer calls already followed to type a local;
 * `awaited`: the chain's value is awaited, so its last call yields what its
 * task/promise resolves to.
 */
function chainPoint(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  consumer: string,
  receiver: ChainSegment[],
  depth: number,
  awaited: boolean,
): InjectionPoint | null {
  const head = receiver[0]!;
  let point: InjectionPoint | null;
  let rest: ChainSegment[];
  if (head.ctor) {
    // `new Report(…).render()` — an instance of the class named.
    point = instancePoint(ctx, head.name, sourceFile, analysis.projectId, consumer);
    rest = receiver.slice(1);
  } else if (receiver.length >= 2 && !head.call && SELF_HEADS.has(head.name)) {
    const own = receiver[1]!;
    point = own.call ? ownMethodResult(ctx, sourceFile, consumer, own.name) : ownMember(ctx, sourceFile, consumer, own.name) ?? globalMember(ctx, sourceFile, own.name);
    rest = receiver.slice(2);
  } else if (head.call) {
    // `root().getPriority()` — what the enclosing class's own method returns;
    // `Report(…).render()` where no such method exists and `Report` is a
    // class — the instance its constructor makes (as Strategy 5 reads a bare
    // class call).
    point = ownMethodResult(ctx, sourceFile, consumer, head.name, awaited && receiver.length === 1)
      ?? instancePoint(ctx, head.name, sourceFile, analysis.projectId, consumer, true)
      ?? importedFunctionResult(ctx, analysis, sourceFile, sourceSymbol, consumer, head.name, awaited && receiver.length === 1);
    rest = receiver.slice(1);
  } else {
    point = scopedName(ctx, analysis, sourceFile, sourceSymbol, consumer, head.name, depth);
    rest = receiver.slice(1);
    // `Factory::getInstance()->run()` — a call on a project class itself.
    if (!point && rest[0]?.call && /^[A-Z]/.test(head.name)) {
      const typeFile = typeFileFor(ctx, head.name, sourceFile, analysis.projectId);
      if (typeFile) point = { typeName: head.name, typeFile, member: "", consumer, container: false };
    }
    // `store.NewRepo()` — a function reached through an imported package or
    // module: the chain goes on from what that function is declared to return.
    // Guarded: `db := db.GetEngine(ctx)` names a local after the package it
    // calls, and resolving the call would type the local by itself again.
    const guard = `${sourceFile}\0${sourceSymbol}\0${head.name}.${rest[0]?.name ?? ""}`;
    if (!point && rest[0]?.call && !resolvingPackageCalls.has(guard) && analysis.imports.some((i) => i.specifiers.includes(head.name) || i.source.split(/[./\\:]/).pop() === head.name)) {
      const name = `${head.name}.${rest[0].name}`;
      const written = findEnclosingCallable(analysis, sourceSymbol)?.calls.find((c) => c.name === name);
      resolvingPackageCalls.add(guard);
      let link: SymbolLink | null;
      try {
        link = resolveCallToDefinition(sourceFile, sourceSymbol, written ?? { name, kind: "internal", target: null, line: 0 }, analysis, ctx);
      } finally {
        resolvingPackageCalls.delete(guard);
      }
      if (link && link.relation === "calls") {
        point = returnedPoint(ctx, symbolIn(ctx, link.targetFile, link.targetSymbol)?.returnType, link.targetFile, { typeName: "", typeFile: null, consumer });
        rest = rest.slice(1);
      }
    }
  }
  for (let i = 0; i < rest.length; i++) {
    const seg = rest[i]!;
    if (!point?.typeFile) return null;
    point = seg.call
      ? methodResult(ctx, point, seg.name, awaited && i === rest.length - 1)
      : ctx.memberTypes.get(memberKey(point.typeFile, point.typeName))?.get(nameKey(ctx.languageOf.get(point.typeFile), seg.name)) ?? null;
  }
  return point;
}

/** Package-function calls being resolved to type a chain head — re-entry would recurse without end. */
const resolvingPackageCalls = new Set<string>();

/**
 * What an imported function returns, as a receiver: `useUserApi()` in `const
 * api = useUserApi()`, resolved like the call the source writes, then typed by
 * the definition's declared return type.
 */
function importedFunctionResult(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  consumer: string,
  name: string,
  awaited: boolean,
): InjectionPoint | null {
  const written = findEnclosingCallable(analysis, sourceSymbol)?.calls.find((c) => c.name === name && c.kind === "cross-file");
  if (!written) return null;
  const guard = `${sourceFile}\0${sourceSymbol}\0${name}()`;
  if (resolvingPackageCalls.has(guard)) return null;
  resolvingPackageCalls.add(guard);
  let link: SymbolLink | null;
  try {
    link = resolveCallToDefinition(sourceFile, sourceSymbol, written, analysis, ctx);
  } finally {
    resolvingPackageCalls.delete(guard);
  }
  if (!link || link.relation !== "calls" || link.targetFile === sourceFile) return null;
  return returnedPoint(ctx, symbolIn(ctx, link.targetFile, link.targetSymbol)?.returnType, link.targetFile, { typeName: "", typeFile: null, consumer }, awaited);
}

/** Longest run of initializer calls followed to type one local (`a = f(); b = a.g(); b.h()`). */
const MAX_INITIALIZER_DEPTH = 3;

/** A local initialized by a call (`localTypes[].from`), typed by what that call is declared to return. */
function initializerPoint(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  consumer: string,
  local: { from?: string; awaited?: boolean },
  depth: number,
): InjectionPoint | null {
  if (!local.from || depth >= MAX_INITIALIZER_DEPTH) return null;
  // The initializer is the receiver of an imagined member call on its result: a call, or a
  // member read off one (`usePublicApi(slug).explore`).
  const chain = receiverChain(`${local.from}.x`);
  if (!chain || chain.length === 0 || chain.length > MAX_RECEIVER_CHAIN + 1 || !chain.some((seg) => seg.call)) return null;
  return chainPoint(ctx, analysis, sourceFile, sourceSymbol, consumer, chain, depth + 1, local.awaited === true);
}

/** One receiver segment of a call chain: `repo`, `getSheet()` (`call`), `new Report(…)` (`ctor`). */
interface ChainSegment {
  name: string;
  call: boolean;
  ctor?: boolean;
}

/**
 * The receiver segments of a call name, leaf dropped: `a.getB(x.y).c` →
 * `a`, `getB()`. Splits on `.` and `::` outside brackets, so arguments that
 * contain dots stay inside their call. Null when the receiver indexes
 * (`rows[i].m()` — an element, not a declared member) or the brackets do not
 * balance.
 */
function receiverChain(callName: string): ChainSegment[] | null {
  const out: ChainSegment[] = [];
  let i = 0;
  const ctor = /^\s*new\s+([\w$\\.]+)\s*(?=\()/.exec(callName);
  if (ctor) {
    const close = closingParen(callName, ctor[0].length);
    if (close < 0 || callName[close + 1] !== ".") return null;
    out.push({ name: ctor[1]!, call: true, ctor: true });
    i = close + 2;
  }
  let start = i;
  let depth = 0;
  const raw: string[] = [];
  for (; i < callName.length; i++) {
    const ch = callName[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return null;
    } else if (depth === 0 && ch === ".") {
      raw.push(callName.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && ch === ":" && callName[i + 1] === ":") {
      raw.push(callName.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  if (depth !== 0) return null;
  // `raw` now holds everything before the leaf.
  for (const text of raw) {
    const seg = receiverSegment(text);
    const paren = seg.indexOf("(");
    if (paren < 0) {
      if (seg.includes("[") || seg.includes("<") || !seg) return null;
      out.push({ name: seg, call: false });
      continue;
    }
    // `getB(…)`, `getB(…)?`, `getB(…)!!` — a call; anything after its
    // argument list (`get(0)[1]`) indexes the result.
    const name = seg.slice(0, paren);
    const close = closingParen(seg, paren);
    if (!name || /[[<]/.test(name) || close !== seg.length - 1) return null;
    out.push({ name, call: true });
  }
  return out;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Return-type spellings that mean "the receiver's own class" (fluent setters, `static` factories). */
const SELF_TYPES: ReadonlySet<string> = new Set(["self", "static", "$this", "this", "Self"]);

/**
 * What a call of `method` on a receiver of the point's type returns, as the
 * next receiver: its DECLARED return type (own or inherited method), resolved
 * from the file that declares it. A method returning its own class
 * (`@return $this`, `-> Self`) keeps the receiver's type, so a fluent chain
 * on a subclass stays on the subclass.
 */
function methodResult(ctx: LinkContext, point: InjectionPoint, method: string, awaited = false): InjectionPoint | null {
  if (!point.typeFile) return null;
  const hit = findMethodInClass(ctx, point.typeName, point.typeFile, method);
  if (!hit) return null;
  return returnedPoint(ctx, symbolIn(ctx, hit.file, hit.symbol)?.returnType, hit.file, point, awaited);
}

/**
 * The point a declared return type names, judged from `declFile`; `self`
 * keeps `receiver`'s type. Awaited, the type is first unwrapped from the
 * language's task/promise type (`Task<User>` → `User`); a type that is not
 * one is taken as written (Python/Rust declare the awaited type themselves).
 */
function returnedPoint(
  ctx: LinkContext,
  returnType: string | null | undefined,
  declFile: string,
  receiver: Pick<InjectionPoint, "typeName" | "typeFile" | "consumer">,
  awaited = false,
): InjectionPoint | null {
  if (!returnType) return null;
  let written = returnType.trim();
  if (awaited) written = awaitedType(written, pluginFor((ctx.languageOf.get(declFile) ?? "") as Language)?.asyncResultTypes);
  if (SELF_TYPES.has(written)) {
    return receiver.typeFile ? { typeName: receiver.typeName, typeFile: receiver.typeFile, member: "", consumer: receiver.consumer, container: false } : null;
  }
  const typeName = receiverTypeName(written, (ctx.languageOf.get(declFile) ?? "") as Language);
  if (!typeName) return null;
  const ref = qualifiedTypeRef(ctx, written, typeName, declFile) ?? typeRefFor(ctx, typeName, declFile, ctx.projectOf.get(declFile) ?? "root");
  return ref ? { ...ref, member: "", consumer: receiver.consumer, container: false } : null;
}

/**
 * A return type written with its package (`*entity.Album`, `entity.Label`) when the name alone is
 * several classes (`Album` in `form`, `entity` and `search`): the one in a directory of that name
 * the declaring file imports.
 */
function qualifiedTypeRef(ctx: LinkContext, written: string, typeName: string, declFile: string): { typeName: string; typeFile: string } | null {
  const pkg = new RegExp(`(?:^|[^\\w.])([a-z_]\\w*)\\.${typeName}(?![\\w.])`).exec(written)?.[1];
  if (!pkg) return null;
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  if (!ctx.analysisByFile.get(declFile)?.imports.some((i) => i.source === pkg || i.source.endsWith(`/${pkg}`))) return null;
  const files = (ctx.classFiles.get(typeName) ?? []).filter((f) => f.slice(0, f.lastIndexOf("/")).split("/").pop() === pkg);
  // One type over several files of the package (Go methods beside the struct): its richest declaration.
  const pick = files.length > 0 ? pickDefinition(typeName, files, files[0]!, (f, n) => ctx.classAt.get(memberKey(f, n)), (f) => ctx.languageOf.get(f)) : null;
  return pick ? { typeName, typeFile: pick } : null;
}

/**
 * What the caller's own method `name()` returns: a method of the enclosing
 * class (own or inherited), else a top-level function of the same file.
 */
function ownMethodResult(ctx: LinkContext, sourceFile: string, consumer: string, name: string, awaited = false): InjectionPoint | null {
  if (consumer && ctx.classAt.has(memberKey(sourceFile, consumer))) {
    return methodResult(ctx, { typeName: consumer, typeFile: sourceFile, member: "", consumer }, name, awaited);
  }
  const def = symbolIn(ctx, sourceFile, name);
  if (!def || def.name !== name) return null;
  return returnedPoint(ctx, def.returnType, sourceFile, { typeName: consumer, typeFile: null, consumer }, awaited);
}

/** `Task<User>` → `User` when `Task` is one of the language's async result types; otherwise as written. */
function awaitedType(written: string, asyncTypes: readonly string[] | undefined): string {
  if (!asyncTypes?.length) return written;
  const open = written.indexOf("<");
  if (open <= 0 || !written.endsWith(">")) return written;
  const name = written.slice(0, open).trim().split(/\.|::/).pop() ?? "";
  // `*Result` names a family by suffix: Rust's `io::Result`, `anyhow::Result`, `FlowyResult`.
  if (!asyncTypes.some((t) => (t.startsWith("*") ? name.endsWith(t.slice(1)) : t === name))) return written;
  const body = written.slice(open + 1, -1);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return body.slice(0, i).trim();
  }
  return body.trim();
}

/**
 * An instance of the project class `written` (`new X(…)`, or — `bareCall` —
 * `X(…)` in languages that construct without `new`). A bare call names a
 * class only when one is declared with exactly that name.
 */
function instancePoint(
  ctx: LinkContext,
  written: string,
  sourceFile: string,
  projectId: string,
  consumer: string,
  bareCall = false,
): InjectionPoint | null {
  const typeName = bareCall ? written : receiverTypeName(written, (ctx.languageOf.get(sourceFile) ?? "") as Language);
  if (!typeName || (bareCall && !/^[A-Z]/.test(typeName))) return null;
  const ref = typeRefFor(ctx, typeName, sourceFile, projectId);
  if (!ref || (bareCall && !ctx.classAt.has(memberKey(ref.typeFile, ref.typeName)))) return null;
  return { ...ref, member: "", consumer, container: false };
}

/** A field of the enclosing class — or, outside any class, of whichever class in the file declares it. */
function ownMember(ctx: LinkContext, sourceFile: string, consumer: string, name: string): InjectionPoint | null {
  const key = memberKey(sourceFile, consumer);
  const member = nameKey(ctx.languageOf.get(sourceFile), name);
  if (consumer && ctx.classAt.has(key)) return ctx.memberTypes.get(key)?.get(member) ?? null;
  return ctx.injectionMap.get(`${sourceFile}::${member}`) ?? null;
}

/**
 * A member the app installs on every component instance (`FileAnalysis.globalMembers`:
 * `app.config.globalProperties.$session = $session`), as `this.$session` reads it in any file of
 * that language family: the installing module's binding, typed where it is declared — the module
 * it is imported from, or the installing file itself. Two installations of one name decide nothing.
 */
function globalMember(ctx: LinkContext, sourceFile: string, name: string): InjectionPoint | null {
  let index = globalMemberIndex.get(ctx);
  if (!index) {
    index = new Map();
    for (const a of ctx.analyses) for (const g of a.globalMembers ?? []) (index.get(g.name) ?? index.set(g.name, []).get(g.name)!).push({ a, g });
    globalMemberIndex.set(ctx, index);
  }
  const installs = index.get(name) ?? [];
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  if (installs.length !== 1 || extensionFamily(installs[0]!.a.filePath) !== extensionFamily(sourceFile)) return null;
  const { a, g } = installs[0]!;
  const imp = a.imports.find((i) => i.specifiers.includes(g.binding));
  const file = imp ? importPath(ctx, imp.source, a.filePath) : a.filePath;
  const holder = file ? ctx.analysisByFile.get(file) : undefined;
  if (!holder) return null;
  const local = imp?.isDefault ? holder.exports.find((e) => e.kind === "default")?.sourceName ?? g.binding : g.binding;
  return scopedName(ctx, holder, holder.filePath, "<setup>", "", local);
}

/** Installed members by name, per link run. */
const globalMemberIndex = new WeakMap<LinkContext, Map<string, Array<{ a: FileAnalysis; g: GlobalMemberDef }>>>();

/** A bare name as the enclosing callable sees it: local, then parameter, then field. */
function scopedName(
  ctx: LinkContext,
  analysis: FileAnalysis,
  sourceFile: string,
  sourceSymbol: string,
  consumer: string,
  name: string,
  depth = 0,
): InjectionPoint | null {
  const callable = findEnclosingCallable(analysis, sourceSymbol);
  const key = nameKey(analysis.language, name);
  let local = callable?.localTypes?.find((l) => nameKey(analysis.language, l.name) === key);
  if (local?.from && !local.type && !local.qualifier) {
    // Every call the local is initialized from (one per branch) must agree.
    const inits = callable!.localTypes!.filter((l) => nameKey(analysis.language, l.name) === key && l.from);
    let typed: InjectionPoint | null = null;
    for (const init of inits) {
      const p = initializerPoint(ctx, analysis, sourceFile, sourceSymbol, consumer, init, depth);
      if (!p || (typed && (typed.typeFile !== p.typeFile || typed.typeName !== p.typeName))) {
        typed = null;
        break;
      }
      typed = p;
    }
    if (typed) return typed;
    // A local that reassigns a parameter (`$repo = $this->fallback()`) keeps
    // the parameter's declared type when the call states none.
    local = undefined;
    if (!callable?.params.some((p) => nameKey(analysis.language, p.name) === key)) return null;
  }
  const param = local ? undefined : callable?.params.find((p) => nameKey(analysis.language, p.name) === key);
  const declared = local ?? param;
  if (declared) {
    const typeName = receiverTypeName(declared.type, analysis.language);
    if (!typeName && !declared.qualifier) return null;
    const ref = typeName ? typeRefFor(ctx, typeName, sourceFile, analysis.projectId) : null;
    const point: InjectionPoint = {
      typeName: ref?.typeName ?? typeName ?? "",
      typeFile: ref?.typeFile ?? null,
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
  // A local of a function the callable is declared in (`const api = useUserApi()`
  // in a composable, read by the functions it returns): lexical scope, as for the module's below.
  if (callable && sourceSymbol !== "<setup>" && depth < 4 && pluginFor(analysis.language)?.moduleLocalsInScope) {
    let outer: FunctionInfo | undefined;
    for (const f of analysis.functions) {
      if (f === callable || f.name.startsWith("<") || f.line > callable.line || f.endLine < callable.endLine || (f.line === callable.line && f.endLine === callable.endLine)) continue;
      if (!f.localTypes?.some((l) => nameKey(analysis.language, l.name) === key)) continue;
      if (!outer || f.endLine - f.line < outer.endLine - outer.line) outer = f;
    }
    if (outer && analysis.functions.filter((f) => f.name === outer!.name).length === 1) return scopedName(ctx, analysis, sourceFile, outer.name, consumer, name, depth + 1);
  }
  // A module-scope binding the callable does not shadow with a typed local
  // or a parameter (`const api = useUserApi()` above `function save() { api.x.y() }`).
  if (sourceSymbol !== "<setup>" && pluginFor(analysis.language)?.moduleLocalsInScope) {
    const setup = analysis.functions.find((f) => f.name === "<setup>");
    if (setup?.localTypes?.some((l) => nameKey(analysis.language, l.name) === key)) {
      return scopedName(ctx, analysis, sourceFile, "<setup>", consumer, name, depth);
    }
  }
  // Where fields need `this.`/`self.`, a bare name is a local or global the
  // body did not type — never the field of the same name.
  if (pluginFor(analysis.language)?.explicitSelfMembers) return null;
  return ownMember(ctx, sourceFile, consumer, name);
}

/**
 * Class `typeName` as `sourceFile` names it: the class a barrel the name is
 * imported from re-exports under it (`export { UserApiClient as UserApi } from
 * "./client-user"`), under its own name — before `typeFileFor`, whose
 * project-wide lookup would take an unrelated class that happens to be
 * called `UserApi` — else the file defining it.
 */
function typeRefFor(ctx: LinkContext, typeName: string, sourceFile: string, projectId: string): { typeName: string; typeFile: string } | null {
  typeName = dealias(ctx, typeName, sourceFile);
  const reexported = reexportedType(ctx, typeName, sourceFile);
  if (reexported) return reexported;
  const typeFile = typeFileFor(ctx, typeName, sourceFile, projectId);
  return typeFile ? { typeName, typeFile } : null;
}

/** `ScoreCalc.Add()` where `ScoreCalc` aliases a class (`using ScoreCalc = League.Scoring.Calc;`): that class's member. */
function aliasedClassMember(ctx: LinkContext, analysis: FileAnalysis, head: string, leafName: string, mkLink: MkLink): SymbolLink | null {
  const target = dealias(ctx, head, analysis.filePath);
  if (target === head) return null;
  const file = typeFileFor(ctx, target, analysis.filePath, analysis.projectId);
  const hit = file ? findMethodInClass(ctx, target, file, leafName) : null;
  return hit ? mkLink(hit.file, hit.symbol, hit.line, "INFERRED", "class-name") : null;
}

/** What `typeName` stands for where it is an alias (`followTypeAlias`), else itself. */
function dealias(ctx: LinkContext, typeName: string, sourceFile: string): string {
  if (!ctx.typeAliases) return typeName;
  return followTypeAlias(ctx.typeAliases, typeName, sourceFile, (name, near) => {
    const lang = ctx.languageOf.get(near) ?? "";
    return (ctx.classFiles.get(name) ?? []).some((f) => sameTypeSpace(near, lang, f, ctx.languageOf.get(f) ?? ""));
  });
}

/** The class an import of `typeName` reaches through a barrel's re-exports; null when the import names a declaration directly, or none. */
function reexportedType(ctx: LinkContext, typeName: string, sourceFile: string): { typeName: string; typeFile: string } | null {
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  let found: { typeName: string; typeFile: string } | null = null;
  for (const imp of ctx.analysisByFile.get(sourceFile)?.imports ?? []) {
    if (!imp.specifiers.includes(typeName)) continue;
    const barrel = importPath(ctx, imp.source, sourceFile);
    const hit = barrel ? forwardedClass(ctx, barrel, typeName, 0, new Set()) : null;
    if (!hit) continue;
    if (found && (found.typeFile !== hit.typeFile || found.typeName !== hit.typeName)) return null;
    found = hit;
  }
  return found;
}

/** The class `file` re-exports as `name`, followed through further barrels (`forwardedDefinition`, for types). */
function forwardedClass(ctx: LinkContext, file: string, name: string, depth: number, seen: Set<string>): { typeName: string; typeFile: string } | null {
  if (depth > MAX_REEXPORT_DEPTH || seen.has(file)) return null;
  seen.add(file);
  let found: { typeName: string; typeFile: string } | null = null;
  for (const e of ctx.analysisByFile!.get(file)?.exports ?? []) {
    if (e.kind !== "re-export" || !e.source || (e.name !== name && e.name !== "*")) continue;
    const inner = e.name === "*" ? name : e.sourceName ?? name;
    const target = resolveTarget(e.source, file, ctx.filePathMap);
    if (!target || target === file) continue;
    const hit = ctx.classAt.has(memberKey(target, inner)) ? { typeName: inner, typeFile: target } : forwardedClass(ctx, target, inner, depth + 1, seen);
    if (!hit) continue;
    if (found && (found.typeFile !== hit.typeFile || found.typeName !== hit.typeName)) return null;
    found = hit;
  }
  return found;
}

/**
 * The project file defining class `typeName` as seen from `sourceFile`: the
 * one definition in the caller's sub-project (or the closest of several),
 * else a definition unique across the whole language family. Null when the
 * type is not a project class or is ambiguous.
 */
function typeFileFor(ctx: LinkContext, typeName: string, sourceFile: string, projectId: string): string | null {
  const declOf = (f: string, n: string) => ctx.classAt.get(memberKey(f, n));
  // The file the source imports the type from, when that file declares it: two
  // same-named classes in other namespaces (`Auth\AuthenticationService`,
  // `Subsonic\AuthenticationService`) are told apart by the `use` that names one.
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  const source = ctx.analysisByFile.get(sourceFile);
  if (source) {
    const named = source.imports.filter((i) => i.specifiers.includes(typeName) || i.source.split(/[\\/.:]+/).pop() === typeName);
    for (const imp of named) {
      const f = importPath(ctx, imp.source, sourceFile);
      if (f && f !== sourceFile && declOf(f, typeName)) return f;
    }
  }
  const languageOf = (f: string) => ctx.languageOf.get(f);
  // The source file's own class of that name is the one the name means there:
  // three test modules each declaring a `SymbolicInterpreter` helper are three
  // classes, and each module's `interp = SymbolicInterpreter()` is its own.
  // Not where one type spans files (partial classes): there the richest
  // declaration below stands for the type.
  if (declOf(sourceFile, typeName) && !typesSpanFiles(languageOf(sourceFile))) return sourceFile;
  // A module reaches another module's class only through an import (`importsBindNames`).
  const reachable = (f: string): boolean => !source || !unboundAcrossModules(ctx, source, typeName, f);
  const own = ctx.classByProject.get(`${projectId}\0${typeName}`);
  if (own) {
    const ownFiles = own.files.filter(reachable);
    const pick = ownFiles.length === 1 ? ownFiles[0]! : ownFiles.length > 1 ? pickDefinition(typeName, ownFiles, sourceFile, declOf, languageOf) : null;
    if (pick) return pick;
  }
  // Elsewhere in the type space: a unique definition — or one type split
  // across files of a single directory.
  const srcLang = ctx.languageOf.get(sourceFile) ?? "";
  const files = (ctx.classFiles.get(typeName) ?? []).filter((f) =>
    sameTypeSpace(sourceFile, srcLang, f, ctx.languageOf.get(f) ?? "") && reachable(f),
  );
  if (files.length === 1) return files[0]!;
  if (files.length > 1 && new Set(files.map((f) => f.slice(0, f.lastIndexOf("/") + 1))).size === 1) {
    return pickDefinition(typeName, files, sourceFile, declOf, languageOf);
  }
  // A namespace import (`using League.Clubs.Interfaces;`) names the directory a
  // definition sits in where folders mirror namespaces: the one it names.
  const named = files.length > 1 && source ? files.filter((f) => importsDirectoryOf(source, f)) : [];
  return named.length === 1 ? named[0]! : null;
}

/** A file that imports or exports anything is a module: its top-level names are its own. */
const isModuleFile = (a: FileAnalysis): boolean => a.imports.length > 0 || (a.exports?.length ?? 0) > 0;

/**
 * `importsBindNames`: whether `name`, written in `source`, could only reach
 * `targetFile` by a global lookup no import supports — a module naming a
 * class it neither declares nor imports, declared in another module. `new
 * Map()` beside a project's own `export class Map`, a `Response` typed by the
 * DOM. A script on either side, an ambient `.d.ts`, a namespace or wildcard
 * import into the project and an auto-import sub-project all keep the lookup.
 */
function unboundAcrossModules(ctx: LinkContext, source: FileAnalysis, name: string, targetFile: string): boolean {
  if (targetFile === source.filePath || !pluginFor(source.language)?.importsBindNames || !isModuleFile(source)) return false;
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  const target = ctx.analysisByFile.get(targetFile);
  if (!target || !isModuleFile(target) || /\.d\.[cm]?ts$/.test(targetFile)) return false;
  for (const imp of source.imports) {
    if (imp.specifiers.includes(name) || Object.values(imp.aliases ?? {}).includes(name)) return false;
    const wildcard = imp.isNamespace || imp.specifiers.includes("*");
    // The module itself, and each name it gives as a module of its own
    // (`from league.pkgs import i18n` → `i18n.ProviderFactory`).
    const sep = imp.source.includes("/") ? "/" : ".";
    const modules = [imp.source, ...imp.specifiers.filter((s) => s !== "*").map((s) => `${imp.source}${imp.source.endsWith(sep) ? "" : sep}${s}`)];
    for (const mod of modules) {
      const f = resolveTarget(mod, source.filePath, ctx.filePathMap);
      if (!f) continue;
      if (f === targetFile || (wildcard && mod === imp.source)) return false;
      // A package: the entry file of a directory named as the module, holding the class.
      const dir = f.slice(0, f.lastIndexOf("/"));
      if (dir.split("/").pop() === mod.split(/[./]/).pop() && targetFile.startsWith(`${dir}/`)) return false;
    }
  }
  if (!ctx.autoImportProjects) {
    ctx.autoImportProjects = new Set();
    for (const a of ctx.analyses) {
      if (pluginFor(a.language)?.importsBindNames?.autoImport?.test(a.filePath)) ctx.autoImportProjects.add(ctx.projectOf.get(a.filePath) ?? "root");
    }
  }
  return !ctx.autoImportProjects.has(ctx.projectOf.get(source.filePath) ?? "root");
}

/** Whether a namespace the source imports is the file's directory, read with dots (`League.Clubs/Interfaces/X.cs`). */
function importsDirectoryOf(source: FileAnalysis, file: string): boolean {
  const dir = file.slice(0, file.lastIndexOf("/")).replace(/\//g, ".");
  return source.imports.some((i) => {
    const ns = i.source.replace(/[\\/:]+/g, ".").replace(/^\.+|\.+$/g, "");
    return ns.includes(".") && (dir === ns || dir.endsWith(`.${ns}`));
  });
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
    // An implementation that does not declare the member is an abstract base:
    // the call runs in the one class below it that does (`ServiceImpl extends
    // AbstractQuery extends … AbstractSupport implements Service`).
    const target = findMethodInClass(ctx, impl.className, impl.classFile, method)
      ?? overrideBelow(ctx, impl.className, impl.classFile, method, sourceIsTest);
    if (target) return throughDeclared(mkLink(target.file, target.symbol, target.line, "INFERRED", "interface-redirect"));
  }

  const target = findMethodInClass(ctx, point.typeName, point.typeFile, method);
  if (target) {
    const link = mkLink(target.file, target.symbol, target.line, "INFERRED", "injection");
    // Inherited: say on which class it was called (see `SymbolLink.viaType`).
    if (!target.symbol.startsWith(`${point.typeName}.`)) Object.assign(link, { viaType: point.typeName, viaTypeFile: point.typeFile });
    return link;
  }
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

/**
 * Every receiver-bearing function/method name → its definitions with the
 * receiver type each extends, so `x.foo()` can resolve on the type of `x`.
 */
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
/**
 * The one class below `className` — its subclasses, theirs, … — that declares
 * `method`, test classes left out of production calls. Null when none or
 * several do.
 */
function overrideBelow(
  ctx: LinkContext,
  className: string,
  classFile: string,
  method: string,
  sourceIsTest: boolean,
): { file: string; symbol: string; line: number } | null {
  const below = (ctx.subclasses ??= buildSubclassIndex(ctx));
  const found: Array<{ file: string; symbol: string; line: number }> = [];
  const seen = new Set([memberKey(classFile, className)]);
  let frontier = [memberKey(classFile, className)];
  for (let depth = 0; depth < MAX_BASE_DEPTH && frontier.length > 0 && found.length < 2; depth++) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const sub of below.get(k) ?? []) {
        const key = memberKey(sub.file, sub.name);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!sourceIsTest && (TEST_DOUBLE_PATH_RE.test(sub.file) || isTestFile(sub.file, (ctx.languageOf.get(sub.file) ?? "") as Language))) continue;
        const def = symbolIn(ctx, sub.file, `${sub.name}.${method}`);
        if (def) found.push({ file: sub.file, symbol: def.name, line: def.line });
        else next.push(key);
      }
    }
    frontier = next;
  }
  return found.length === 1 ? found[0]! : null;
}

/** `${file}\0${class}` → the classes that extend it, each base located as `findMethodInClass` locates it. */
function buildSubclassIndex(ctx: LinkContext): Map<string, Array<{ name: string; file: string }>> {
  const out = new Map<string, Array<{ name: string; file: string }>>();
  for (const [key, cls] of ctx.classAt) {
    if (cls.kind === "interface" || !cls.extends) continue;
    const base = bareClassName(cls.extends);
    if (!base) continue;
    const file = key.slice(0, key.indexOf("\0"));
    const baseFile = locateClass(ctx, base, file, ctx.projectOf.get(file) ?? "root");
    if (!baseFile) continue;
    const baseKey = memberKey(baseFile, base);
    (out.get(baseKey) ?? out.set(baseKey, []).get(baseKey)!).push({ name: cls.name, file });
  }
  return out;
}

/**
 * The overrides a route's own class supplies for the methods its base-class
 * handler calls on itself: a route served by `MatchController` through the
 * inherited `RestController.GetById`, which calls the abstract `GetResourceById`,
 * reaches `MatchController.GetResourceById` — never another subclass's.
 */
function ownerOverrideLinks(
  route: RouteInfo,
  sourceFile: string,
  sourceSymbol: string,
  analysis: FileAnalysis,
  ctx: LinkContext,
): SymbolLink[] {
  const handlerName = route.handler!.split(/[#.]/).pop()!;
  const host = analysis.classes.find((c) => c.name !== route.owner && route.line >= c.line && route.line <= c.endLine && c.methods.some((m) => m.name === handlerName));
  const owner = classEntryFor(ctx.classCatalog.get(route.owner!), sourceFile);
  if (!owner || owner.count !== 1) return [];
  if (!host) {
    // A handler the framework supplies (DRF's `create` on a `ModelViewSet`): no project method serves
    // the route, so the owner's own body (its `queryset`) is all it states.
    const ownerClass = ctx.classAt.get(memberKey(owner.file, route.owner!));
    const declared = ownerClass?.methods.some((m) => m.name === handlerName) || findMethodInClass(ctx, route.owner!, owner.file, handlerName);
    if (!ownerClass || declared) return [];
    return [{ sourceFile, sourceSymbol, sourceLine: route.line, callName: route.owner!, targetFile: owner.file, targetSymbol: route.owner!, targetLine: ownerClass.line, confidence: "INFERRED", strategy: "route-override", relation: "calls" }];
  }
  const action = host.methods.find((m) => m.name === handlerName && route.line >= m.line && route.line <= m.endLine)
    ?? host.methods.find((m) => m.name === handlerName)!;
  const own = new Set(host.methods.map((m) => m.name));
  const ownerClass = ctx.classAt.get(memberKey(owner.file, route.owner!));
  const out: SymbolLink[] = [];
  // What the owner states in its own body (`queryset = Club.objects.all()` on a viewset whose
  // handlers it inherits) is what those handlers serve.
  if (ownerClass) {
    out.push({
      sourceFile,
      sourceSymbol,
      sourceLine: route.line,
      callName: route.owner!,
      targetFile: owner.file,
      targetSymbol: route.owner!,
      targetLine: ownerClass.line,
      confidence: "INFERRED",
      strategy: "route-override",
      relation: "calls",
    });
  }
  for (const call of action.calls) {
    // `_providerFactory.All()` on a field the owner handed the base: on the owner's type.
    const onField = /^(?:this\.)?(\w+)\.(\w+)$/.exec(call.name);
    const handed = onField && ownerClass && bareClassName(ownerClass.extends) === host.name ? handedType(ownerClass, host, onField[1]!) : null;
    if (handed) {
      const link = resolveCallToDefinition(sourceFile, sourceSymbol, { ...call, receiverType: handed }, analysis, ctx);
      if (link) {
        const typeArgs = typeArgumentsAt(ctx, handed, owner.file, link.targetFile, link.targetSymbol);
        out.push({ ...link, strategy: "route-override", ...(typeArgs ? { typeArgs } : {}) });
      }
      continue;
    }
    const name = /^(?:this\.|self\.|base\.)?(\w+)$/.exec(call.name)?.[1];
    if (!name || name === handlerName || !own.has(name)) continue;
    const override = findMethodInClass(ctx, route.owner!, owner.file, name);
    if (!override || override.symbol === `${host.name}.${name}`) continue;
    const typeArgs = typeArgumentsAt(ctx, route.owner!, owner.file, override.file, override.symbol);
    out.push({
      sourceFile,
      sourceSymbol,
      sourceLine: call.line,
      callName: call.name,
      targetFile: override.file,
      targetSymbol: override.symbol,
      targetLine: override.line,
      confidence: "INFERRED",
      strategy: "route-override",
      relation: "calls",
      ...(typeArgs ? { typeArgs } : {}),
    });
  }
  return out;
}

function findMethodInClass(
  ctx: LinkContext,
  className: string,
  classFile: string,
  method: string,
): { file: string; symbol: string; line: number } | null {
  // Several class bases (Python): the C3 method resolution order decides.
  if (pluginFor(ctx.languageOf.get(classFile) as Language)?.multipleInheritance && ctx.classAt.get(memberKey(classFile, className))?.implements.length) {
    const mro = methodResolutionOrder(ctx, className, classFile);
    if (mro) {
      for (const c of mro) {
        const def = symbolIn(ctx, c.file, `${c.name}.${method}`);
        if (def) return { file: c.file, symbol: def.name, line: def.line };
      }
      return null;
    }
  }
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
    // A class extends a class: an interface of the same name (`Contracts\Repository`
    // beside the abstract `Repository`) is no candidate when the name ties.
    const baseFile = locateClass(ctx, base, file, ctx.projectOf.get(file) ?? "root")
      ?? onlyConcrete(ctx, base, ctx.classAt.get(key)?.kind === "interface", file);
    if (!baseFile) return null;
    name = base;
    file = baseFile;
  }
  return null;
}

/**
 * C3 linearization of a class whose bases are all classes (`class D(B, C)`):
 * the class, then its bases merged so each comes before its own bases and
 * the declared order is kept. Bases outside the project (`object`,
 * `models.Model`) are left out. Null when the hierarchy has no consistent order.
 */
function methodResolutionOrder(ctx: LinkContext, name: string, file: string, depth = 0, seen = new Set<string>()): Array<{ name: string; file: string }> | null {
  const key = memberKey(file, name);
  if (depth > MAX_BASE_DEPTH || seen.has(key)) return null;
  const cls = ctx.classAt.get(key);
  const self = { name, file };
  if (!cls) return [self];
  const inner = new Set(seen).add(key);
  const bases: Array<{ name: string; file: string }> = [];
  for (const written of [cls.extends, ...cls.implements]) {
    const base = bareClassName(written);
    const baseFile = base ? locateClass(ctx, base, file, ctx.projectOf.get(file) ?? "root") : null;
    if (base && baseFile) bases.push({ name: base, file: baseFile });
  }
  const lists: Array<Array<{ name: string; file: string }>> = [];
  for (const b of bases) {
    const l = methodResolutionOrder(ctx, b.name, b.file, depth + 1, inner);
    if (!l) return null;
    lists.push(l);
  }
  lists.push([...bases]);
  const id = (c: { name: string; file: string }) => memberKey(c.file, c.name);
  const out = [self];
  while (lists.some((l) => l.length > 0)) {
    const head = lists.find((l) => l.length > 0 && !lists.some((o) => o.slice(1).some((c) => id(c) === id(l[0]!))))?.[0];
    if (!head) return null;
    out.push(head);
    for (const l of lists) if (l.length > 0 && id(l[0]!) === id(head)) l.shift();
  }
  return out;
}

/** A symbol of `file` by name — case-insensitively where the file's language names callables so. */
function symbolIn(ctx: LinkContext, file: string, name: string): SymbolDef | undefined {
  const exact = ctx.symbolIndex.get(file)?.get(name);
  if (exact || !callablesFoldCase(ctx.languageOf.get(file))) return exact;
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

/** The one non-interface declaration of `name` in `nearFile`'s type space (an interface's base may be an interface). */
function onlyConcrete(ctx: LinkContext, name: string, fromInterface: boolean, nearFile: string): string | null {
  if (fromInterface) return null;
  const lang = ctx.languageOf.get(nearFile) ?? "";
  const files = (ctx.classFiles.get(name) ?? []).filter((f) =>
    ctx.classAt.get(memberKey(f, name))?.kind !== "interface" && sameTypeSpace(nearFile, lang, f, ctx.languageOf.get(f) ?? ""));
  return files.length === 1 ? files[0]! : null;
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

/** Every free function name → the files defining it and their declared return types. */
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
        const def = targetSymbols.get(imp.aliases?.[spec] ?? spec);
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

/** What a plugin's import resolver may ask, built once per linking run. */
function importResolveContext(ctx: LinkContext): ImportResolveContext {
  if (ctx.importResolve) return ctx.importResolve;
  ctx.analysisByFile ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
  const byFile = ctx.analysisByFile;
  const files = new Set(byFile.keys());
  ctx.importResolve = {
    files,
    declares: (file, name) => {
      const a = byFile.get(file);
      return !!a && (a.functions.some((f) => f.name === name) || a.classes.some((c) => c.name === name));
    },
    globImportsOf: (file) => (byFile.get(file)?.imports ?? []).filter((i) => (i.specifiers ?? []).length === 0 || i.specifiers.includes("*")).map((i) => i.source),
  };
  return ctx.importResolve;
}

/**
 * `IRepo<Club, List<int>>` → `{ name: "IRepo", args: ["Club", "List<int>"] }`,
 * the name without its namespace. Null for anything not shaped `Name` or `Name<…>`.
 */
function parseGenericType(written: string): { name: string; args: string[] } | null {
  const t = written.trim().replace(/\?$/, "");
  const lt = t.indexOf("<");
  const name = bareSupertypeName(lt < 0 ? t : t.slice(0, lt));
  if (!/^\w+$/.test(name)) return null;
  if (lt < 0) return { name, args: [] };
  if (!t.endsWith(">")) return null;
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of t.slice(lt + 1, -1)) {
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  args.push(cur.trim());
  return args.every(Boolean) ? { name, args } : null;
}

/** A written type with each type parameter replaced by what it is bound to. */
function substituteTypeParameters(written: string, bound: ReadonlyMap<string, string>): string {
  return bound.size === 0 ? written : written.replace(/\b\w+\b/g, (w) => bound.get(w) ?? w);
}

/**
 * Every class a written type is, itself and its bases transitively, each with
 * the type arguments it is closed over from there: `ClubRepository` (`:
 * BasicRepository<Club>`) → `BasicRepository` with `["Club"]`, and
 * `IBasicRepository` with `["Club"]` above it. Keyed by `${file}\0${class}`.
 */
function closedAncestors(ctx: LinkContext, written: string, fromFile: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (w: string, near: string, depth: number): void => {
    const parsed = parseGenericType(w);
    if (!parsed || depth > 8) return;
    const file = locateClass(ctx, parsed.name, near, ctx.projectOf.get(near) ?? "root");
    if (!file) return;
    const key = memberKey(file, parsed.name);
    const cls = ctx.classAt.get(key);
    if (!cls || out.has(key)) return;
    out.set(key, parsed.args);
    const params = cls.typeParameters ?? [];
    const bound = new Map<string, string>();
    if (params.length === parsed.args.length) params.forEach((p, i) => bound.set(p, parsed.args[i]!));
    for (const base of [cls.extends, ...cls.implements]) {
      if (base) visit(substituteTypeParameters(base, bound), file, depth + 1);
    }
  };
  visit(written, fromFile, 0);
  return out;
}

/**
 * What the type parameters of the class declaring `targetSymbol` are bound to
 * when a receiver of the written type calls it: the type's own arguments when
 * the class is among its bases (`ClubRepository` → `BasicRepository<Club>`),
 * else unified through a base both share (an `IRepository<Club>` receiver whose
 * call lands on the implementation `Repository<T> : IRepository<T>` binds `T`).
 * Null when the class is not generic or nothing binds it; disagreeing paths bind nothing.
 */
function typeArgumentsAt(ctx: LinkContext, written: string, fromFile: string, targetFile: string, targetSymbol: string): Array<string | null> | null {
  const dot = targetSymbol.lastIndexOf(".");
  if (dot <= 0) return null;
  const className = targetSymbol.slice(0, dot);
  const target = ctx.classAt.get(memberKey(targetFile, className));
  const params = target?.typeParameters ?? [];
  if (params.length === 0) return null;
  const up = closedAncestors(ctx, written, fromFile);
  const direct = up.get(memberKey(targetFile, className));
  if (direct) return direct.length === params.length ? direct : null;
  const down = closedAncestors(ctx, `${className}<${params.join(", ")}>`, targetFile);
  const binding: Array<string | null> = params.map(() => null);
  for (const [key, symbolic] of down) {
    const closed = up.get(key);
    if (!closed || closed.length !== symbolic.length) continue;
    for (let j = 0; j < symbolic.length; j++) {
      const i = params.indexOf(symbolic[j]!);
      if (i < 0) continue;
      if (binding[i] !== null && binding[i] !== closed[j]) return null;
      binding[i] = closed[j]!;
    }
  }
  return binding.some((b) => b !== null) ? binding : null;
}

/**
 * Bind each link into a generic class's method to the type arguments its
 * caller closes that class over (`SymbolLink.typeArgs`): a call on a member,
 * parameter or local whose declared type names them, or a self-call from a
 * subclass that closes its base. A self-call inside the class itself binds
 * nothing (the parameters stay its own).
 */
function annotateTypeArguments(links: SymbolLink[], ctx: LinkContext): void {
  const fnAt = new Map<string, FunctionInfo>();
  let indexed = false;
  for (const link of links) {
    if (link.typeArgs || link.navigational) continue;
    const dot = link.targetSymbol.lastIndexOf(".");
    if (dot <= 0 || !ctx.classAt.get(memberKey(link.targetFile, link.targetSymbol.slice(0, dot)))?.typeParameters?.length) continue;
    const sDot = link.sourceSymbol.lastIndexOf(".");
    const sourceClassName = sDot > 0 ? link.sourceSymbol.slice(0, sDot) : null;
    const sourceClass = sourceClassName ? ctx.classAt.get(memberKey(link.sourceFile, sourceClassName)) : undefined;
    let written: string | null | undefined = null;
    const onMember = /^(?:(?:this|base|self)\.)?(\w+)\.\w+$/.exec(link.callName);
    if (onMember) {
      const member = onMember[1]!;
      const point = sourceClass ? ctx.memberTypes.get(memberKey(link.sourceFile, sourceClassName!))?.get(nameKey(ctx.languageOf.get(link.sourceFile), member)) : undefined;
      written = point?.written ?? point?.typeName;
      if (!written) {
        if (!indexed) {
          indexed = true;
          for (const a of ctx.analyses) {
            for (const fn of a.functions) fnAt.set(memberKey(a.filePath, fn.name), fn);
            for (const cls of a.classes) for (const m of cls.methods) fnAt.set(memberKey(a.filePath, `${cls.name}.${m.name}`), m);
          }
        }
        const fn = fnAt.get(memberKey(link.sourceFile, link.sourceSymbol));
        written = fn?.params.find((p) => p.name === member)?.type ?? fn?.localTypes?.find((l) => l.name === member)?.type;
      }
    } else if (/^(?:(?:this|base|self)\.)?\w+$/.test(link.callName)) {
      if (sourceClass && !(link.sourceFile === link.targetFile && sourceClassName === link.targetSymbol.slice(0, dot))) {
        written = sourceClass.typeParameters?.length ? `${sourceClassName}<${sourceClass.typeParameters.join(", ")}>` : sourceClassName;
      } else if (link.sourceSymbol.startsWith("route:")) {
        // A route served through an inherited handler runs on its owner's instance.
        ctx.analysisAt ??= new Map(ctx.analyses.map((a) => [a.filePath, a]));
        written = ctx.analysisAt.get(link.sourceFile)?.routes.find((r) => r.owner && `route:${r.httpMethod ?? "USE"} ${r.path}` === link.sourceSymbol)?.owner;
      }
    }
    if (!written) continue;
    const typeArgs = typeArgumentsAt(ctx, written, link.sourceFile, link.targetFile, link.targetSymbol);
    if (typeArgs) link.typeArgs = typeArgs;
  }
}
