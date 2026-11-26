# src/extractors — Per-language extraction

Everything that walks an AST or regex-scans source text to pull out structured data. Cross-file analysis is `src/core/`'s job — with one deliberate exception: a plugin may contribute a **project-level reconciliation** pass (`EntityExtractor.reconcileProject`) for a join that needs both language knowledge AND the whole file set (a schema file's columns joined onto models declared elsewhere — see [Ruby](plugins/ruby/AGENTS.md)). Core invokes these generically — language-specific cross-file logic still belongs in the plugin, never in core.

**All language-, ORM-, and framework-specific code lives under `plugins/`.** Core never names a language; it asks the registry or calls a generic hook. A `.rb` path check, a pluralization rule, or a `schema.rb` parser in `src/core/` is a layering bug.

## Structure

```
extractors/
├── registry.ts            THE language plugin registry — aggregates every plugin's meta.ts
├── imports-exports/       plugin interface + dispatcher
├── functions-classes/     plugin interface + dispatcher
├── data-sources/          plugin interface + dispatcher (API calls, state hooks, ORM queries, MQ publish/consume)
├── data-mutations/        plugin interface + dispatcher (setState, dispatch, assignments)
├── routes/                plugin interface + dispatcher (one RouteExtractor per language family)
├── entities/              ORM entity + relation extraction (per-file extract + project-level reconcile)
├── plugins/               per-language implementations (see plugins/AGENTS.md)
└── shared/                language-agnostic utilities (call graph, link scoring, helpers)
```

Each of `imports-exports`, `functions-classes`, `data-sources`, `data-mutations`, `routes` has:
- `base.ts` — abstract class / interface defining the plugin contract
- `index.ts` — thin dispatcher that looks up the plugin's extractor instance via
  `pluginFor(language)` (`meta.functionsClasses`, `meta.routes`, …). Domain
  index files import NO plugin code — the meta is the only path from the
  registry to a plugin's implementation.

## The registry (registry.ts)

Each plugin directory exports a `LanguagePluginMeta` from `meta.ts` (see
[../types/language-plugin.ts](../types/language-plugin.ts)) carrying everything
language-specific, including the domain extractor instances
(`functionsClasses`, `importsExports`, `routes`, `dataSources`,
`dataMutations`, `entities`, `dispatchResolvers` — family plugins share one
instance across member metas) plus:

- `extensions` + `parsing` ("tree-sitter" | "regex" | "custom") — drives discovery and `file-analyzer`'s parse strategy
- `grammar` (tree-sitter wasm location + per-file variant selection), `regexSpec` (RegexLangSpec), `customParse` (dedicated parsers, e.g. Delphi forms), `preprocess` (container formats, e.g. single-file components)
- `builtinTypes`, `externalModulePrefixes`, `externalNamespaceRoots`, `standardImport` (the language's own standard library, asked only for its files) — import/type-resolution data
- `complexity` (branch nodes / logical ops), `securityRules` (+ `securityPreprocess`/`securityInLiteral`/`securityPostScan`/`skipSecurityScan`)
- `frameworkImportHints`, `apiCallRoots`, `dbCallRoots`
- `ast` hooks: `typeReferences`, `interactiveElements`, `subComponents`, `events`, `variableAliases`
- `calls` hooks: `callNodeTypes`, scope/callback node types, name resolution, auto-imported classification
- `apiContract` (manifest) — the language describes an API rather than implementing it (OpenAPI, GraphQL SDL, WSDL, JSight, Protocol Buffers); `isApiContractLanguage()` is how core asks
- `schemaFormat` (manifest) — the language's classes are data shapes (SQL tables, Prisma models, a Core Data model; see each language's file), never types code constructs or calls; with `apiContract` languages they make `declaresSchemaTypes()`, which keeps those classes out of the symbol linker's indexes and type catalogs (functions — a stored procedure, a named query — stay targets)

**Project-level passes.** Some facts only exist across files: a base controller's
route template, a Django `include("app.urls")`, a URL helper defined in another
module. A plugin reports what one file shows and contributes a pass that joins
them; core runs every pass generically and never names a framework:

- `routeResolvers` ([route-resolvers/](route-resolvers/)) — rewrite
  `analysis.routes` before mounts compose and before the symbol linker anchors
  them. Replace a row you change (the runner stamps `resolvedBy` on new rows);
  emit `prefixUnresolved` when an outer prefix exists but cannot be known.
  Per-file inputs no `RouteInfo` can carry go in `FileAnalysis.routeFacts`.
- `dataSources.resolveProject` — rewrite api-call targets across the project
  (the JS URL-builder pass lives here).
- `entities.reconcileProject`, `dispatchResolvers` — the entity pass (below) and dispatch resolution.
- `autoImports` ([imports-exports/auto-imports.ts](imports-exports/auto-imports.ts)) — names a framework
  puts in scope without an import line (Nuxt's `composables/` and `utils/`): add the `ImportInfo` the file
  would have written and classify those calls cross-file, before the import index and the linker. In memory
  only. A member of an unimported factory's result carries the factory in `CallInfo.via` for it.
- `projectPasses` ([project-passes.ts](project-passes.ts)) — async passes that read what they need from
  disk and add to the analyses in memory, before the import index and the linker: routes a build plugin
  generates from a page folder (unplugin-vue-router, vite-plugin-pages), a component's `templateUrl`
  template. Each returns a count `analyze --verbose` prints under its `label`.

Two per-file and static hooks serve the same rule: `ast.fileRoutes` gives the routes a file's place states
(file-based routing — Next.js, Nuxt, SvelteKit, Astro, Expo Router, flat routes), and the manifest's
`resolveImportByFiles` reads an import from the file set alone for core's generic `resolveImportSource`
(Python's dotted modules). A YAML/JSON document skeleton that plugins and core both read is
[shared/spec-document.ts](shared/spec-document.ts).

Each receives a `ProjectContext` ([../types/project.ts](../types/project.ts)):
the import index, a class index (`resolve`, `supertypes`, `ancestors`,
`descendants` — import-aware, refusing ties), `resolveModule` and `fileOf`.

**Two tiers.** Each plugin also has a `manifest.ts` — the STATIC tier
(`LanguagePluginManifest`): extensions, `family`, parsing kind, grammar
location, test-file patterns, external prefixes/roots, builtin members,
framework import hints, `frameworks.ts` rules, `activationFiles`, `projectMarkers` (the files that mark a sub-project root: kind, priority, optional root predicate),
`dispatchLanguages`, `docComments` (from `shared/doc-comment-specs.ts`),
and the plugin's package managers (`packageManagers` —
manifest parsers + how an import names a package, from `package-manifests.ts`
— and `packageEcosystems`, the ecosystems the language imports from; `importPackageNames`, the distribution
names an import may be listed under — a dotted `azure.storage.blob` → `azure-storage-blob`). Known-package
tables answer by ecosystem: an import is classified only by the plugins sharing a registry with the importing
language (`importPackageScopeOf`), a declared package by those of its own (`ecosystemPackageScopeOf`) — one ecosystem's known-package rule never classifies another's import.
The registry imports every manifest EAGERLY and builds the module-scope
constants from them (`EXTENSION_TO_LANGUAGE`, `STRIP_SOURCE_EXTENSION_RE`,
`ALL_EXTERNAL_MODULE_PREFIXES`, `EXTERNAL_NAMESPACE_ROOT_RE`,
`ALL_BUILTIN_MEMBERS`, `FRAMEWORK_RULES`, `PACKAGE_MANAGERS`,
`testFilePatternsFor`, `inferFileFrameworks`). Manifests are leaf modules:
types, the plugin's `frameworks.ts` and `package-manifests.ts` and leaf
rules only. Static data a tool reads on demand (the MCP server loads no
plugin until it analyzes) belongs here, never on the meta. Each
meta spreads its manifest so static fields have one source of truth.

The metas (LAZY tier) sit behind a static thunk map (`LOADERS`) of dynamic
imports — tsdown's ESM code splitting emits one chunk per plugin. `await
ensureLanguagesLoaded(langs)` (or `loadAllPlugins()`) populates `pluginFor`;
the analyzer calls it after file discovery with the discovered languages ∪
`ACTIVATION_FILE_LANGUAGES` hits (go.mod → go, …) ∪ dispatch couplings
(`manifest.dispatchLanguages` — a language whose project needs another's resolvers, e.g. VB with C#'s UI bridge). `analyzeFile` self-activates per file as a safety net.
`pluginFor` THROWS for a registered-but-unloaded language (silent undefined
would quietly degrade extraction); vitest loads everything via
`src/test-setup.ts`. Lazy-tier accessors: `pluginFor`, `astHooksFor`,
`complexityFor`, `regexSpecFor`, `securityRulesFor`, `classifyKnownPackage`
(rebuilt from loaded metas in manifest order; the analyzer passes its
`pluginScopeOf` — the languages it loaded — so a process that analyzed another
repository first, with more plugins loaded, classifies this one's packages the
same), `allPluginMetas` (loaded metas, manifest order).

The registry also pushes data into the leaf modules plugin code itself
imports (`shared/builtin-types.ts`, `shared/call-patterns.ts`,
`shared/link-scoring.ts` — these must NOT import the registry: plugin code
imports them and the registry imports the metas, so a static import back
would close an ESM cycle and TDZ plugin classes).

**Adding a language**: create `plugins/<lang>/` with the domain extractors you
support, a `manifest.ts` + `meta.ts` (meta spreads the manifest), and register
BOTH in `registry.ts` — the manifest in `ALL_MANIFESTS`, the meta in `LOADERS`.

**Layering rule**: metas are leaf modules — they import types, their own plugin
code, and leaf shared helpers, never core or the registry. Core never names a
language; it asks the registry.

## The plugin pattern (domain extractors)

```ts
// base.ts — abstract contract
export abstract class FunctionClassExtractor {
  abstract readonly languages: Language[];
  extractFunctions(tree, sourceText): FunctionInfo[] { ... }
  extractClasses(tree, sourceText): ClassInfo[] { ... }
  protected abstract collectFunctions(node, functions): void;
  protected abstract collectClasses(node, classes): void;
}

// index.ts — dispatcher (no plugin imports; instances live on the metas)
export function extractFunctions(tree, sourceText, language): FunctionInfo[] {
  return pluginFor(language)?.functionsClasses?.extractFunctions(tree, sourceText) ?? [];
}
```

## shared/ utilities

Language-agnostic helpers are described in [shared/AGENTS.md](shared/AGENTS.md); the entry points:

| File | Purpose |
|------|---------|
| [call-graph.ts](shared/call-graph.ts) | `extractCalls(body, language)` — main function-call walker. `classifyCalls(calls, imports, lang)` — sets `kind` to `cross-file`/`internal`/`api-call`/`database`. `extractVariableAliases` — `const s = useStore()` → maps `s` to import source |
| [call-patterns.ts](shared/call-patterns.ts) | `isApiCall(name)`, `isDatabaseCall(name)` — pattern matchers used by `classifyCalls`. Per-language root lists come from plugin metas via the registry. |
| [link-scoring.ts](shared/link-scoring.ts) | `buildLinkGraph(analyses)` — file → file edges with proximity (1=tight, 2=medium, 3=loose). `resolveTarget(importSource, sourceFile, filePathMap)` — turns `"./foo"` or `"com.example.Foo"` into a file path. `buildFilePathMap` — index for fast resolution. External-package prefixes come from plugin metas via the registry. |
| [builtin-types.ts](shared/builtin-types.ts) | `isBuiltinType(name, language)` — per-language deny sets come from plugin metas via the registry; exports `COMMON_PRIMITIVES` as the base for plugin sets. |
| [tsconfig-aliases.ts](shared/tsconfig-aliases.ts) | Import aliases of the nearest config directory, rewritten into imports before call classification: tsconfig/jsconfig `paths` + `baseUrl` (`extends` — relative, array, or a package's config through `node_modules` or the workspace package of that name; `${configDir}` is the loading config's directory — and a solution-style config's `references`), a pattern chosen as TypeScript chooses it (exact, else the longest prefix before `*` whose suffix also matches; each target tried in order, the first holding a module wins; a catch-all `*` that finds nothing, or lands in `node_modules`, leaves the import alone), filled by [bundler-aliases.ts](shared/bundler-aliases.ts) — the literal `resolve.alias` of `vite.config.*` / `webpack.config.*` / `vue.config.*` (object or array form, an `aliases` object imported from a sibling file), kept only when it points into the project; and the aliases a framework writes only into its generated tsconfig — Nuxt's `~`/`@`/`~~`/`@@`, SvelteKit's `$lib` (`kit.files.lib`, else `src/lib`) and `kit.alias` entries, whose bare paths are relative to the project root (one inside `node_modules` is left out). Never throws: a config of an unexpected shape contributes nothing | Language-specific extractors live in their plugins and are wired through each meta's `ast` hooks.

## routes/

Same registry pattern as the other domains: `routes/base.ts` defines
`RouteExtractor` (`languages` + `extractRoutes(tree, sourceText)`), and each
language family exports one:
- `javascript/routes/index.ts` — runs the JS route readers in order ([JavaScript](plugins/javascript/AGENTS.md))
- `python/routes.ts` and `python/django/` — decorator routes and mounts; Django urlconfs and DRF routers are per-file `routeFacts` that route resolvers join ([Python](plugins/python/AGENTS.md))
- `csharp/routes/aspnet.ts` — attribute routes, base-controller inheritance and custom routing attributes ([C#](plugins/csharp/AGENTS.md))
- `java-kotlin/routes/spring.ts` ([Java/Kotlin](plugins/java-kotlin/AGENTS.md))
- `pascal/routes.ts` ([Pascal](plugins/pascal/AGENTS.md))

Regex-path languages extract routes inside their `plugins/<lang>/index.ts` via `RegexLangSpec.extractRoutes`.

**Mount prefixes are a project-level pass, not a per-file one.** A route's real
path often comes from a *different file* — `app.use("/api/auth", authRoutes)`
(Express) or `include_router(auth.router, prefix="/users")` (FastAPI). A
per-file extractor cannot see it, so it emits the mount as an api route marked
`mount: true` (`httpMethod: null`, `handler` = the router identifier), and
[shared/router-mounts.ts](shared/router-mounts.ts) resolves that identifier
through the import index after per-file analysis, prefixes the target file's
routes, merges mount-level `middleware`/`auth`, `middlewareCalls` and
`inheritedMiddleware` onto every mounted route (`middlewareCalls` resolve in
the mounting file), and drops the mount. It is language-agnostic — reading only
`FileAnalysis.routes` — so a new framework joins by emitting mounts in that
shape. The marker is required: a null-method route with an identifier handler
is also an "any method" endpoint (Compojure `ANY`, Express `all`), and only
`mount: true` says it is wiring. The pass runs before the symbol linker, so
`route:<METHOD> <path>` anchors carry the composed path the route map shows. Only emit a mount when the prefix is a **literal**: an unresolvable one
leaves a non-endpoint sitting in the route map. Getting this wrong is not
cosmetic — `dedupeRoutes` keys on method+path, so several routers' un-prefixed
`@router.get("")` collapse into a single endpoint.

## entities/ (ORM entities + relations)

`entities/base.ts` defines `EntityExtractor`; each plugin subclasses it in
`plugins/<lang>/entities.ts` and wires the instance as `meta.entities`. Two surfaces:

- **`extract(ctx)`** — per file: emit entity `ClassInfo`s (merged into
  `analysis.classes` by name) + `EntityRelation`s. This is where the bulk of
  ORM detection lives.
- **`reconcileProject(analyses)`** — optional project-level pass run once over
  the whole file set (core calls `reconcileProjectEntities`, which invokes every
  extractor's pass). Use it for a join that genuinely needs both language
  knowledge and all files at once (the Ruby plugin's schema-column join: [Ruby](plugins/ruby/AGENTS.md)). Keep the language-specific logic here in the plugin;
  core only knows the generic hook.

## Conventions

- Extractors return **raw extractions** — call classification (internal vs cross-file) happens in `classifyCalls()` after extraction
- Line numbers are **1-based** in output (tree-sitter is 0-based — convert: `node.startPosition.row + 1`)
- Extractors should never call each other directly; they communicate via `FileAnalysis` fields
- Noise filtering (skip `console.log`, `.map`, `.filter`, etc.) is centralized in `call-graph.ts` `NOISE_CALLS`
- Dispatch resolvers' output passes `dropProductionToTestLinks` (`dispatch/index.ts`), and so do queue links: production
  code never links into a test or story file. The linker's interface fan-out skips test doubles the same way.
- Factory results and component emits are stated as facts for the linker (`FunctionInfo.returnedMembers`, `returnedFrom`, `derivedLocals`, `FileAnalysis.dynamicEmits`): the rules are in the [JavaScript](plugins/javascript/AGENTS.md) file. A call site reading the member states a `returned` derivation step, and `paramOrigins` follows it. Plugins state, core links.
