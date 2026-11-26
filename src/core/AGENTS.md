# src/core — Analysis pipeline & analyzers

The analysis pipeline orchestrator and all cross-file analyzers live here. Pure functions in / out — no tree-sitter parsing happens at this layer (that's delegated to extractors).

**Core is language-agnostic.** Anything per-language — extensions, parse
strategy, builtin types, complexity tables, security rules, framework hints,
external-package prefixes, AST hooks — comes from the plugin registry
([../extractors/registry.ts](../extractors/registry.ts)), which aggregates each
plugin's `meta.ts`. Don't hardcode language names, ORMs, frameworks, or file
conventions here; ask the registry. Even a **cross-file** join that needs
language knowledge stays in the plugin: core calls a generic hook (e.g.
`reconcileProjectEntities` → each entity extractor's `reconcileProject`), it
never names the language. A `schema.rb` parser or a pluralization rule in
`src/core/` is a layering bug, and so is an import of
`extractors/plugins/<language>/` from production code here —
[core-imports.test.ts](core-imports.test.ts) fails on one (`plugins/shared/`
holds language-free helpers and is allowed).

Where a pass is described below, its file's header comment holds the rules (tiers, refusals, edge cases); this
file keeps the map and what spans files. Per-language spellings of the facts a pass reads live in each plugin's
`AGENTS.md` ([../extractors/plugins/](../extractors/plugins/AGENTS.md)).

## Entry point

[analyzer.ts](analyzer.ts) exports `analyze(options)` — the full pipeline (stages: `## The pipeline, step by step`).

Every step is gated behind the `ProgressReporter`, in both verbose and non-verbose modes.

- **Import edges of the component graph.** A package import (`importsNameDirectories`) resolves to the ONE directory the language's `packageDirectory` rule names from the repository's packages (`SubProject.packageName` + `packages`; the standard library and downloads are no directory), else to the directory whose path ends with the longest run of its segments (a tie is no edge), narrowed to the files declaring a name the importer uses, tests excluded. Dead code reads these edges as reachability, so a phantom fan-out hides real gaps. Per language: [Go](../extractors/plugins/go/AGENTS.md), [Rust](../extractors/plugins/rust/AGENTS.md), [Ruby](../extractors/plugins/ruby/AGENTS.md).
- **External imports bind nothing.** An import of a third-party package a manifest of the repository declares (`declaredPackageImports`, matched as package usage is) or of the language's standard library (`standardImport`) is no project file, and the names it binds are never matched to a project file exporting the same name.
- **Stage timings.** A stage's time (`stageTimings`, `--verbose` `Timings:`) runs from its `progress.step`/`progress.status` line to the next one, so a long span of passes carries `progress.status("…")` sub-steps at group boundaries. They emit `step` events and leave `STAGE_OF` and the stage ids alone, since consumers of `--progress json` key on those. A new pass goes under the sub-step it belongs to; a sub-step under about 50 ms is merged into its neighbour.

## Analyzers (post-analysis passes)

All take `FileAnalysis[]` and/or `componentGraph` and return typed results.

**Dependency order matters.** Health and suggestions depend on everything else. The analyzer computes the import cycles ONCE (`findCircularDeps` over the runtime graph of authored, non-test files — type-only edges and edges only a dynamic `import()` states (`dynamicImportEdges`) dropped) and hands them to refactor pressure, health and suggestions (`cycles`). A cycle group is a set: print it with `cycleChain` (a path the imports really take), never as members joined by arrows.

### Linking

- [symbol-linker.ts](symbol-linker.ts) — `SymbolLink[]`: call→definition links through the fallback cascade documented on `buildSymbolLinks` (direct, inheritance, declared-type resolution, DI, unique-global-leaf, route/spec/fan-out producers); the value-flow, reactive-trigger and abstract-dispatch passes run inside it.
- [symbol-graph.ts](symbol-graph.ts), [symbol-dedup.ts](symbol-dedup.ts), [overload-args.ts](overload-args.ts), [type-aliases.ts](type-aliases.ts), [class-index.ts](class-index.ts), [class-evidence.ts](class-evidence.ts), [class-namespaces.ts](class-namespaces.ts) — the graph walk and the gate (`usageGate`), dedupe and overload choice, alias following and the class lookups the linker shares with `member-effects.ts`.
- [reactive-triggers.ts](reactive-triggers.ts) — a write of a reactive cell links to the callbacks watching it (`dispatch:reactive-trigger`); the cross-component JS resolvers are the JavaScript plugin's.
- [value-flow.ts](value-flow.ts) — the callable value-flow solver behind the `value-flow` strategy (`valueFlowLinks`, after `handedParameterLinks`/`handedClientLinks`, before `abstractDispatchLinks`).
- [typed-receivers.ts](typed-receivers.ts) (per file, before `classifyCalls`), [inheritance-edges.ts](inheritance-edges.ts) (component-graph edges for supertypes no import names), [project-call-data-sources.ts](project-call-data-sources.ts) (drops the `db-write` a name-classified call on a project class made), [client-proxies.ts](client-proxies.ts) (REST client proxy calls), [grpc-clients.ts](grpc-clients.ts) (gRPC stub calls), [foreign-bindings.ts](foreign-bindings.ts) (links across a generated language bridge).
- [wrapper-index.ts](wrapper-index.ts) — the one import-resolved index behind `expandRequestFactories` and the JS plugin's `resolveUrlBuilders`; [typed-member-holes.ts](typed-member-holes.ts) expands `${typed.member}` URL holes over a closed string type.
- [member-effects.ts](member-effects.ts) — `ProjectAnalysis.fieldWrites` / `thrownTypes`; [member-dependents.ts](member-dependents.ts) names the files that use a changed member.

**Dispatch-side data passes** (in memory, before the data-access pass; each file's header holds its rules): [channel-factories.ts](channel-factories.ts) (queue rows through a wrapper's channel parameter), [channel-topics.ts](channel-topics.ts) (topic scoping, MQTT holes and filters), [entity-parameters.ts](entity-parameters.ts) (a helper's model parameter), [mixin-self.ts](mixin-self.ts) (a mixin's access on its own receiver).

**Data flow** — [data-flow-reach.ts](data-flow-reach.ts) (`symbolReach`, `dataFlows`: effects reached through the symbol links, the usage gate, route identity and middleware reads), [api-route-symbol-links.ts](api-route-symbol-links.ts) (click→data trace edges, `routeHandlerKey`, `declaredOn`), [route-symbol.ts](route-symbol.ts) (`routeSymbolName`: every core site naming a route's symbol goes through it).

**Sequence** — [sequence.ts](sequence.ts), [sequence-frames.ts](sequence-frames.ts), [sequence-order.ts](sequence-order.ts): Mermaid `sequenceDiagram`, served by `clarifydoc seq` and `clarifydoc_sequence`, on demand and never stored.

### Value resolution and service origins

Order of the passes: module values → route bases → (link) → call origins → route linking.

- [module-values.ts](module-values.ts) — `ModuleValueLookup`, `resolveTargetRefs`, `resolveRouteTemplates`: the string a name stands for, followed into the module defining it (api-call URLs, queue targets, route paths).
- [call-origins.ts](call-origins.ts) — mutates `apiCalls[].origin`: reference → values → host, then proxy forwarding. Inputs: client registrations, deployment, [config-values.ts](config-values.ts), [service-addresses.ts](service-addresses.ts).
- [route-bases.ts](route-bases.ts) — prefixes a project's configured base onto its API routes, after router mounts and before the linker; `stateLocalPaths`/`dropUnchangedLocalPaths` bracket the mount and base passes so a composed route carries `RouteInfo.localPath` (never set by a plugin; the route linker's added-base tier and search's below-base alias read it before the conventional list).
- [module-search-paths.ts](module-search-paths.ts), [compilation-database.ts](compilation-database.ts) — in-memory rewrites of imports and includes to the file the project's build files mean ([Pascal](../extractors/plugins/pascal/AGENTS.md), [C++](../extractors/plugins/cpp/AGENTS.md), [C](../extractors/plugins/c/AGENTS.md)).

### Parameters and contracts

- [param-origins.ts](param-origins.ts) — `ParamOrigin[]`: where an API call's URL slot value starts, followed back through callers.
- [param-columns.ts](param-columns.ts) — `ParamColumn[]`: the route parameter followed forward to the column a statement filters on (`clarifydoc_contract`, FLOWS.md).
- [project-dependencies.ts](project-dependencies.ts) — `ProjectDependency[]`: sub-project → sub-project `http`, `bus` and `package` edges.
- [contract-check.ts](contract-check.ts) — `ContractFinding[]`: a call's body against the route's closed schema.
- [request-schemas.ts](request-schemas.ts) — handler `params` and `routeMap[].requestSchema`; [route-linker.ts](route-linker.ts) — `apiRouteLinks` (the three tiers, contract twins via `codeTwinsIndex`).

### Screens and navigation

- [rendered-views.ts](rendered-views.ts) (`ScreenInfo.renderedBy`), [server-redirects.ts](server-redirects.ts) (`RouteInfo.redirectsTo`) — both read `symbolLinks` and raw handler source through [route-handlers.ts](route-handlers.ts).
- [screen-navigation.ts](screen-navigation.ts) — adds the navigation of other files' components a screen builds.
- [screen-flow.ts](screen-flow.ts) — `ProjectAnalysis.screenFlow`, the navigation map the Screens tab draws. A screen is the sum of what makes it up (components it renders, code-behind, view model): a component's links and dialogs count for every page that imports it.
- [test-functions.ts](test-functions.ts) (test verdict basis `described`), [test-navigations.ts](test-navigations.ts) (`testNavigations`: browser-test pages joined to screens; the verdict's `navigation` basis).

### Quality passes

One file each; the header holds the rules.

- [blast-radius.ts](blast-radius.ts), [complexity-analyzer.ts](complexity-analyzer.ts), [pattern-detector.ts](pattern-detector.ts), [responsibility-profile.ts](responsibility-profile.ts), [security-scanner.ts](security-scanner.ts), [duplication-detector.ts](duplication-detector.ts), [layer-analyzer.ts](layer-analyzer.ts), [refactor-pressure.ts](refactor-pressure.ts), [dead-code.ts](dead-code.ts), [health-scorer.ts](health-scorer.ts), [suggestions-engine.ts](suggestions-engine.ts).
- [control-flow.ts](control-flow.ts) — one function's `Cfg`, built on demand and never written to `project-summary.json` ([control-flow-file.ts](control-flow-file.ts), [control-flow-mermaid.ts](control-flow-mermaid.ts), [control-flow-regex.ts](control-flow-regex.ts), [control-flow-slice.ts](control-flow-slice.ts)). Two gates in `control-flow.test.ts`: `cyclomaticFromCfg` must equal `computeComplexity`, and `undrawnStructure` must come back empty.
- [rules-init.ts](rules-init.ts) — `clarifydoc rules init`.
- Performance patterns are ordered widest reach first by `rankPerformanceByReach` (finding-entries.ts); only their slots are permuted, the set never changes.

## Per-file analysis & workers

- [file-analyzer.ts](file-analyzer.ts) — `analyzeFile(task)`: read + parse + run all extractors + write the per-file JSON. Pure per-file logic with no pipeline state, so it can run on any thread.
- [analyze-worker.ts](analyze-worker.ts) — worker_threads entry that wraps `analyzeFile`. Built as its own tsdown entry (`dist/analyze-worker.js`).
- [worker-pool.ts](worker-pool.ts) — `AnalysisWorkerPool`, generic over its task: projects ≥200 files (`CLARIFYDOC_WORKERS=<n>`, `0` disables), dying workers, heap bound and shrinking are described in its header. The query-in-loop pass hands it the files whose control-flow graphs it needs ([loop-shape-batch.ts](loop-shape-batch.ts)).
- [unread-code.ts](unread-code.ts) — code files no plugin reads, counted by extension (`ProjectAnalysis.unreadCode`); [ignore-suggestions.ts](ignore-suggestions.ts) — generated and vendored roots to put in `.clarifydocignore`.
- [feature-flags.ts](feature-flags.ts) — extraction paths switched by name (`KNOWN_FEATURES`, `CLARIFYDOC_FEATURES`, `analyze --feature`: `no-antlr`, `antlr:go`, `-antlr:lua`; the most specific name wins). What differs from the defaults joins `EXTRACTOR_VERSION` in `extractorStamp()` (manifest.ts), so a run reading files another way never reuses cached JSON. A feature ships beside the path it replaces; `scripts/ab-features.mjs <project> --feature <name>` analyzes one tree with and without it and lists every disagreement. Two features, both on by default: `antlr` and `tree-sitter` (a regex language's `meta.antlr` reader, else its `meta.treeSitter` reader, supplies its functions and calls through `readWithParser` in file-analyzer.ts; `FileAnalysis.frontEnd` says which reading a file got). When the spec builds its own classes, `adoptParsedMembers` (regex-extractor.ts) pairs parsed functions with class methods.

## Discovery & IO

- [file-discovery.ts](file-discovery.ts) — a glob walk by extension; `EXTENSION_MAP` is the source of truth for which extensions are analyzed. Every walk goes through [glob.ts](glob.ts) (tinyglobby), which never follows links; a new walk imports `glob.ts`, never the engine. The walks of one analysis share directory listings (`shareDirectoryEntries` in [../extractors/shared/dir-listings.ts](../extractors/shared/dir-listings.ts)); a walker of its own reads through `listEntries` / `sharedEntries`, not `readdir`, and may `prune` directories.
- [clarifydoc-ignore.ts](clarifydoc-ignore.ts) — `.clarifydocignore` / `.clarifydoc/ignore` in gitignore syntax, applied through `globUnignored` by every reader that walks the tree for its own files; `fnmatch` is the only glob engine (`project-config.ts` shares it).
- [framework-detector.ts](framework-detector.ts) — gathers `ProjectInfo` per project root and runs plugin-contributed rules (`plugins/<lang>/frameworks.ts` → `FRAMEWORK_RULES`) into `FrameworkDetection[]`; core knows no framework names.
- [deployment.ts](deployment.ts) — compose/Kubernetes topology (`ProjectAnalysis.deployment`); see also [deployment-terraform.ts](deployment-terraform.ts), [deployment-cloudformation.ts](deployment-cloudformation.ts), [dockerfiles.ts](dockerfiles.ts), [deploy-rejects.ts](deploy-rejects.ts).
- [read-text-file.ts](read-text-file.ts) — `readTextFile` / `decodeText` read manifests, build and config files; `readSourceText` reads sources.
- [manifest.ts](manifest.ts) — `manifest.json`, written by every run that writes, read only by `--incremental`.
- [output-writer.ts](output-writer.ts) — per-file JSONs + `project-summary.json` (+ LSP files when LSP runs). With a worker pool a task with `deferWrite` hands its bytes back and the analyzer gives them to four idle workers after the sources are read (`CLARIFYDOC_HELD_OUTPUT_MB`, default 256); the run waits for them before the summary and a file not written is left out of the manifest.
- [element-registry.ts](element-registry.ts) — the disk codec: `normalizeProject` / `denormalizeProject`, every reader goes through it. A round-trip test over every fixture is the gate; a new path-bearing `ProjectAnalysis` field is added to `rewritePageRefs`.
- [context-docs.ts](context-docs.ts), [stated-reasons.ts](stated-reasons.ts) — decision records and stated reasons for `clarifydoc_context_docs`; on demand only, never during `analyze`.
- [project-config.ts](project-config.ts) — `<root>/.clarifydoc/config.json` (optional, never fatal): `layers`, `exempt`, `generated`, `context`, `refactorPressure`. Owners of a section resolve it; `matchesAnyGlob` is the one glob test.
- [regex-extractor.ts](regex-extractor.ts) — thin dispatcher for regex-only languages; the logic lives in `src/extractors/plugins/<lang>/`.
- [config-keys.ts](config-keys.ts), [config-files.ts](config-files.ts), [env-vars.ts](env-vars.ts), [ci-pipelines.ts](ci-pipelines.ts), [vuln-reach.ts](vuln-reach.ts), [queue-env-targets.ts](queue-env-targets.ts) — the post-link inventories; each header holds its rules.

## Report

**One renderer, prebuilt.** The report viewer is a React app maintained outside this repository. `report.html` is that viewer built into a single self-contained file (react + d3 + dagre + css inlined, fully offline) with the payload JSON injected. This package carries only the built template; report features are written in the viewer, and rebuilding it refreshes `report-template.html`.

- `html-report.ts` — `generateHtmlReport` loads the prebuilt template from `html-report/viewer-assets/report-template.html` (committed; mirrored into `dist/` by the root tsdown `onSuccess` hook), swaps `__CLARIFYDOC_TITLE__` / `__CLARIFYDOC_PAYLOAD__` and also writes `report-data.json` (plain JSON, for consumers that serve the payload in slices).
- `report-payload.ts` — `buildReportPayload(summary)` reshapes a (denormalized) `ProjectAnalysis` into the `ReportPayload` the viewer consumes; `loadReportSummary(dir)` / `loadReportPayload(dir)` read it from disk (with the `lsp-enhancement.json` merge).
- `smoke.test.ts` renders a minimal report end-to-end and round-trips hostile payload content through the encoder.

## Adding a new analyzer

1. Create `src/core/my-analyzer.ts` exporting a pure function `analyzeMyThing(input): MyResult[]`.
2. Add the return type to [../types/analysis.ts](../types/analysis.ts) and an optional field to `ProjectAnalysis`.
3. Wire it into the `analyzer.ts` post-analysis section (step 4c).
4. Pass its data to `suggestions-engine.ts` if it should drive suggestions.
5. If the viewer should show it, add it to `report-payload.ts`; the tab itself is written in the viewer, which is then rebuilt into `report-template.html`.
6. Add exports to [../index.ts](../index.ts) if public API.

## Conventions

### Rules for core code

- **Language-agnostic** — core names no language, ORM, framework or file convention; it asks the registry or a plugin hook. Plugins state facts, core resolves them (never pre-resolve in a plugin).
- **Pure functions** — no file IO except `output-writer.ts` and `html-report.ts`; input is `FileAnalysis[]`, output typed results.
- **Optional fields** — new `ProjectAnalysis` / `FileAnalysis` fields are optional so old `project-summary.json` files load.
- **One import contract** — `import-index.ts` turns every specifier into a file through one helper (`resolveSpecifier`), by the name the module exports (`ImportInfo.aliases[local]`, never the local alias), for a language's own `resolveImport` and the generic path, in `localFor` and `fileForSource` alike.
- **Progress** through `ProgressReporter` in `analyzer.ts`, never `console.log`.
- **BFS** with an index pointer (`let qi = 0; while (qi < queue.length) { ... queue[qi++]; ... }`), never `Array.shift()`.
- **Link guards** — a heuristic link needs a stated basis (declared type, import, same sub-project, one candidate); the undecidable stays unlinked or AMBIGUOUS.
- **Memos per link run** live on `LinkContext.memos`, never in module-level state.

### Cross-file mechanisms

- **Impact** ([changed-symbols.ts](changed-symbols.ts), [impact-diff.ts](impact-diff.ts), [member-dependents.ts](member-dependents.ts)): changed lines become symbols (`symbolsInHunks`, `symbolsOfChange`), then `computeImpactDiff` cuts dependents to the files that name what changed; the rules sit in `impact-diff.ts` and `member-dependents.ts`.
- **Lint and caret assertions** — [analysis-lint.ts](analysis-lint.ts) (`lintAnalysis`; `analysis-lint.test.ts` gates every `test-output/` summary, a new rule must be clean on a fresh fixture set or fix the extractor) and [caret-assertions.ts](caret-assertions.ts) (a comment line under a source line whose `^^^` marks a span; `caret-testkit.ts` is the vitest helper, never imported by the product; `caret-fixture.test.ts` walks `CARET_FIXTURES`).
- **Spec join and contract twins** — a contract row with exactly one production code route joins by operation id only (`spec-join`, `codeServes` in symbol-linker.ts; `pairContractTwins`); both deciders count twins by ONE rule, `codeTwinsIndex` in route-linker.ts.
- **Graph notes** — `EntityGraphNode.origin: "contract"` (entity-graph.ts) and `queue::<broker>::<address>` nodes (data-access-graph.ts) are explained where they are built.

## The pipeline, step by step

The ordered overview; the root `AGENTS.md` lists every fact each stage reads, and the file headers hold the rules.

1. **Discover files** — [file-discovery.ts](file-discovery.ts); vendored roots and banners stay analyzed but contribute no routes, screens, calls or data (`dropVendoredFacts`); code no plugin reads is only counted ([unread-code.ts](unread-code.ts)).
2. **Detect frameworks** — [framework-detector.ts](framework-detector.ts).
3. **Detect sub-projects** — [project-detector.ts](project-detector.ts); every file gets a `projectId`. Marker files are each plugin's `projectMarkers` (`ProjectMarkerSpec`); the registry builds `PROJECT_MARKERS` and `PROJECT_KIND_PRIORITY`; a manifest's `declaredProjects` hook adds the directories a build file names.
4. **Per-file analysis** — "Per-file analysis & workers". With `--incremental`, unchanged files reuse cached JSON.
5. **Post-analysis**, in order: component graph, link graph, symbol links, plugin route resolvers (before router mounts compose and before the symbol linker anchors routes: mounts and includes, `owner: "fn:<name>"` rows + `router-call` facts composed by [plugins/shared/router-functions.ts](../extractors/plugins/shared/router-functions.ts), guards from [plugins/shared/class-guards.ts](../extractors/plugins/shared/class-guards.ts) and [plugins/shared/guard-words.ts](../extractors/plugins/shared/guard-words.ts)), dispatch resolvers (`abstractDispatchLinks`, a manifest's `foreignImportTarget` / `foreignImportMember`), stated local paths, route identity (`dedupeRoutes`), client resolution (`resolveProject`, `finalizeApiTargets`, `expandRequestFactories`), client-proxy and gRPC calls, call origins and forwarding, route linking, handler params and request schemas, server redirects and the navigation map, webhook routes ([webhook-routes.ts](webhook-routes.ts)), click→data trace edges, value flow.
6. **LSP enhancement** (optional) — resolves unresolved calls; writes `lsp-enhancement.json` + `lsp-ground-truth.json`. The Docker probe (`isDockerAvailable`) starts before cross-file linking and is awaited here; a run where no language has a configured server never probes. Containers run with `--network none` (`LspDockerConfig.network`, `dockerRunArgs`) except servers that restore packages to type-check, which say `"bridge"`; `cli/SECURITY.md` states it.
7. **Advanced analysis** — quality and topology, data-access and entity graphs, external-package inventory, deployment topology, config keys and files, environment variables, CI deploys ([ci-pipelines.ts](ci-pipelines.ts)), cross-file taint ([cross-file-taint.ts](cross-file-taint.ts)), dead code, health and suggestions, test coverage ([test-coverage.ts](test-coverage.ts)), doc drift ([doc-drift.ts](doc-drift.ts)), performance patterns ([query-in-loop.ts](query-in-loop.ts)), ignore suggestions, type-only import edges ([import-kinds.ts](import-kinds.ts)), named communities ([community-names.ts](community-names.ts)), entry points, external API specs and external services.
8. **Write output** — per-file JSON + `project-summary.json` + `report-data.json` (viewer payload, written unconditionally) (+ `manifest.json`, + optional `report.html`). The JSON artifacts are streamed in slices ([json-stream.ts](json-stream.ts)), byte-identical to `JSON.stringify(v, null, 2)`, written to `<name>.partial` and renamed; large text goes out through `writeTextFile`.

## Data structures in detail

- `RouteInfo` — the attribute layer is kept, not just the path: `middleware` (guard strings), `auth` (policies/roles/schemes/anonymous, structured), `versions`/`deprecatedVersions`, `params` (each handler parameter with its binding: body/query/route/header/form/services, `inferred` when derived from framework defaults). A page route carries `renderMode` (`ssr`/`ssg`/`isr`/`csr`, copied to `ScreenInfo.renderMode`) only where the framework's own settings state it. Field names are language-agnostic; any plugin can fill them. Decorators (`FunctionInfo`/`ClassInfo`/`PropertyInfo.decorators`) carry their **arguments** in every language — never reduce an attribute to its bare name.
- `ProjectAnalysis` — aggregated: `subProjects`/`fileProjects`, `componentGraph`, `linkGraph` (weighted), `symbolLinks` (call→def, `resolvedBy`, `confidence`), `routeMap`, `apiCalls`, `apiRouteLinks`, `projectDependencies`, `screens`, `entityGraph`, `dataAccessGraph`, `classGraph`, `migrations`, `externalPackages`, `deployment`, `deadCode`, `fieldWrites`/`thrownTypes`, plus all quality/topology results.

## How to extend the core

Plugins state facts, core decides; every hook below lives on the plugin's static manifest or `meta.ts` ([../types/language-plugin.ts](../types/language-plugin.ts)) and is leaf code that keeps no module state. Per-language spellings are in the plugin folders' `AGENTS.md`.

- **Teach a plugin a DI container** — plugins only report facts; core resolves. Never pre-resolve in a plugin.
  - Fill `ParamInfo`/`PropertyInfo.type` as written (core normalizes with `receiverTypeName`, unwrapping `meta.transparentTypeWrappers`), `qualifier` for a token/key on an injection point, constructor params, `FunctionInfo.localTypes` for typed locals and container lookups, `CallInfo.receiverType` for a lookup chained into a call (`meta.calls.receiverTypeOf`, or a regex `callPatterns` entry), `ClassInfo.kind: "interface"` (+ `structural: true`), and registrations as `FileAnalysis.diBindings` (`meta.ast.diBindings` / `RegexLangSpec.extractDiBindings`).
  - A local initialized by a call that states no type is stated as that call in `localTypes[].from` (spelled by `callChainText`, `awaited` when awaited; one entry per distinct initializer, a stated type always wins). Core types it through declared return types (`FunctionInfo.returnType`; `asyncResultTypes` unwraps the async wrapper), and only when every initializer agrees.
  - The arms of one conditional initializer are marked with a shared `localTypes[].choice`; arms are all-or-nothing — one initializer core cannot type leaves the local untyped, so plugins emit every arm and never pre-filter. Separate declarations of one name in different blocks carry no `choice`.
  - A union type (manifest `candidateTypeUnions`) links once per candidate that declares the member: AMBIGUOUS when the targets differ, INFERRED when one declares it, untyped when any candidate is no project class.
  - A type read off one assignment is `localTypes[].inferred`; core drops it when another assignment of the name is a call it cannot type or one typing another class.
  - A `DiBinding` says asking for `service` (type or token) yields `implementation`, with `qualifier`/`keyedOnly`, `primary`, `matchesMemberName`, `consumer` (contextual), `ifAbsent`, `conditional` (active only under a profile or condition, yielding to an unconditional binding).
  - Core picks: test containers never apply to production code; contextual beats general; the consumer's own sub-project beats others (which must agree); a default yields to a real registration; then ONE implementation, or one primary, or one named like the member — otherwise it refuses to choose and the call stays on the interface.
- **Teach a plugin where services are** — a leaf `plugins/<lang>/service-config.ts` exporting a `ServiceConfigSpec` on the manifest's `serviceConfig`:
  - `sources`: config files at each project root and a parser returning `ConfigEntry`s — mark `profile`/`test`, `env` for variables a profile sets, `listen` for URLs the project binds; core keeps only URL-shaped values; `ConfigEntry.envNames` carries the variables that override an entry.
  - `baseRefOf`: a base expression as written → `env`/`config`/`literal` `CallBaseRef`, with `fallback` for a default literal (`?? "…"`). `envNamesFor`: config key → overriding env vars. `normalizeKey`: a key's relaxed spelling.
  - `routeBaseOf`: every entry → the base the project serves its routes under, profiles never; [route-bases.ts](route-bases.ts) prefixes the complete API routes (`RouteInfo.basePath`).
  - `proxySources`: config files declaring forwarding rules → `ProxyRule`s ([plugins/shared/proxy-kit.ts](../extractors/plugins/shared/proxy-kit.ts)); a code file's proxies go through `meta.ast.proxyRules`.
  - Clients go through `meta.ast.httpClientRegistrations` / `RegexLangSpec.extractHttpClientRegistrations` (keyed the way a call names the client) and the call row's `baseRef: { kind: "client" }` or `client`; a generated proxy of an API interface sets `proxyOf` to its fully qualified name, and core turns every call on a receiver of that type into a contract call. Routes declared on a typed API set `RouteInfo.contract`.
  - Never resolve a host in the plugin — core's call-origin pass does. `.env` files are never read (discovery treats them as secrets).
  - Labelled fixture: `test-fixtures/sample-microservices` + [cross-project-fixture.test.ts](cross-project-fixture.test.ts).
- **Add a package manager** — a `PackageManagerSpec` in `plugins/<lang>/package-manifests.ts`, listed in the manifest's `packageManagers`:
  - The manifest files to read at each root (exact names or bounded globs, `firstOnly`, `readSibling` for a lockfile) and a parser per format; `selfName` for the package the project publishes; `registry` when its names are another ecosystem's.
  - How an import names a package: `importKey`, `packageKey`, `prefixMatch`, `assertsUnused` only where EVERY import of a package is visible, `installedOwners`, `installedApi` (read on demand by `clarifydoc_extract package=`, never during analysis).
  - Each language lists the ecosystems it imports from in `packageEcosystems`. It lives on the static manifest because the inventory reads every manifest whether or not the language was discovered.
  - [dependency-inventory.ts](dependency-inventory.ts) only walks the roots, dedupes, classifies and counts — it names no ecosystem but `.gitmodules`.
- **Judge a language for dead code** — give its meta a `reachability` hook (`ReachabilityHooks`): `load()` returns a model that says which files START the program (`entryReason` — these anchor a project), which are merely RUN BY A TOOL (`passiveReason`: kept alive, never reported, anchor nothing), resolves an import specifier to the files it loads (`resolve`: `[]` = external, `null` = local but unknown) and resolves `pathReferences`/template tags.
  - `judgeExports: false` when imports don't name what they use. A language that reaches by NAME declares `declaredNames` (core reaches a file when any reachable file's text mentions one); `configMentions` anchor what the framework instantiates by name; `unitOf` makes a directory one unit; `foldNames` for case-insensitive names.
  - Declarative specs are built by [plugins/shared/reachability-kit.ts](../extractors/plugins/shared/reachability-kit.ts); extension-less `#!` scripts are read through [plugins/shared/shebang-scripts.ts](../extractors/plugins/shared/shebang-scripts.ts). Markup and schema formats are never judged but are read as mention sources; a published library's modules are its API, not dead.
  - Only declare it for a language whose imports NAME files — an import graph cannot prove namespace- or autoload-found files unreachable. Measure precision on a real repo first: every finding is an accusation. `test-fixtures/sample-dead-code` + [dead-code-fixture.test.ts](dead-code-fixture.test.ts) are labelled by hand.
- **Explain a complexity number** — `clarifydoc cfg <file> --function <name>` renders one function's control-flow graph as Mermaid ([control-flow.ts](control-flow.ts)); `--slice <line>` prints the backward slice instead ([control-flow-slice.ts](control-flow-slice.ts)). On demand only: it reads one file and never reaches `project-summary.json`.
  - Node roles come from `meta.controlFlow` ([control-flow-defaults.ts](../extractors/shared/control-flow-defaults.ts), the shared C-family table; `extendControlFlow` adds a plugin's spellings).
  - A language with no grammar gets a second front end, not a second builder: [control-flow-regex.ts](control-flow-regex.ts) synthesizes nodes of the SAME canonical types (`FlowNode` in [../types/control-flow.ts](../types/control-flow.ts) is the seam) through `meta.regexControlFlow`, marked `approximate` everywhere it shows. Keyword-delimited languages add `blockDelta` (what a line opens) beside `blockClose`, plus `armBlocks` and `inlineGuard`.
  - The regex tier is gated against the parser: ≥90% of TypeScript and Java functions and ≥85% of C# ones must come out the same shape ([control-flow-regex.test.ts](control-flow-regex.test.ts)). `clarifydoc cfg --capabilities` lists covered languages; the VS Code `$(flame) complexity N` CodeLens falls back to the Complexity report for the rest.
- **Tell the impact report how to run tests** — a manifest's `testCommand(tests, ctx)` returns the runner's command for test files and the test functions a change reaches; `projectCommands(root)` reads how a project is built, tested and started (`ProjectAnalysis.projectCommands`, shown in `clarifydoc_status` and the `install` guidance block); `TestCommandContext.projectTests` hands a plugin the project's own test commands.
  - A command needing a stated fact reads it from `TestTarget.suites` (`FileAnalysis.testSuites`) or `TestCommandContext.testTargets`. `testSetupRuns(root, files)` names the files a test run executes while setting up, which the test-reach verdict counts as tested (`ProjectAnalysis.testSetupRuns`). `blockingCalls` names the calls that block inside async code; `docComments` is the comment syntax tools read on demand.
- **Teach a plugin a taint reader** — a regex language states its `TaintSpec` through `meta.regexTaint` (`{ gate, taint }`): a file whose source matches the gate is parsed once more with the one tree-sitter grammar variant the manifest registers (in `dist/grammars`; the `taint` feature switches it off) for the shared `handlerTaint` walk. The walk reads expression values from `valueParts`, guards through one `condition(ifNode)` text hook; `TaintSpec.binds` follows a request body bound into a struct, `stringReads` string captures.
- **Draft architecture rules** — `clarifydoc rules init` ([rules-init.ts](rules-init.ts)); `clarifydoc install --remove` ([../agents/remove.ts](../agents/remove.ts)) reverses every install writer; `mcp --print-config --pin` prints `npx -y clarifydoc@<version>`.

## Performance rules

- **Profiling:** `CLARIFYDOC_WORKERS=0 node --cpu-prof --cpu-prof-dir=<dir> dist/cli.js analyze …` (workers=0 keeps per-file work in the profile), then aggregate the profile per function. Self-time is too flat to act on — aggregate **inclusive** time per function.
- **Thermal-resistant metric:** wall clock swings up to 3× on laptops. Track the nonParse/parse ratio instead — `(inclusive analyzeFile − inclusive parseSource) / parseSource`; parseSource is fixed WASM work, so the ratio isolates extraction efficiency.
- **Correctness gates for any perf change:** (1) byte-identical per-file JSON on a real corpus (diff ignoring `analyzedAt`); (2) regenerate fixtures and diff `test-output/`; (3) vitest.
- **Worker pool:** the cap of 8 workers is empirically optimal (more measured slower). Each worker's young generation is capped at 16 MB (`CLARIFYDOC_WORKER_YOUNG_MB`, `0` = V8's default, which scales with machine memory): cold-run peak RSS −20 to −27 % on three 4,000–6,500-file repositories, output identical.
- **V8 hidden-class trap:** `Node.type` is cached on instances via a patched prototype getter (parser-manager.ts). Do **not** add more lazily-created cache properties to nodes — it forks hidden classes and makes all node property access megamorphic (measured 3.5× slowdown in route extraction). Cache per-file data in `Map<node.id, value>` memos instead. `id`/`startIndex`/`startPosition`/`tree` are free fields; `endPosition`/`endIndex`/`text`/`childForFieldName` cross into WASM per call.
- **Walk fusion:** full-tree walks dominate non-parse time; fuse N extractor walks into one traversal with per-extractor buckets.
  - Stateful extractors keep per-file state — fused walks must call the base-class `beginFile`/`endFile` hooks around the traversal or state silently goes stale.
  - `extractCalls` does not enter a childless node whose type no step of its walk reads (not a scope, binding site or call type) when the plugin states no per-node hook (`readNames`, `collectExtraCalls`, `destructuredFromCall`, `heldFunction`) and no `skip` is given (`READ_TYPES_BY_LANGUAGE`, [call-graph.ts](../extractors/shared/call-graph.ts)); a hook that only acts on some node types is gated on them before it reads text.
- **Memos per link run:** the linker's per-run caches are the `memos` object of `LinkContext` (`LinkMemos`: `typeFileFor` per (type, file, project), callable members, include closures …), never module-level `WeakMap`s; never spread a context; anything a memo reads from the context must be built before linking starts. `namesNothingDeclared` / `declaredLeafNames` refuse a dotted call whose last name no file declares before the receiver is walked; `namespaceHeadMember`, `packageFilesOf` and `familyHoldsMaps` are memoized the same way.
- **Flat trees:** `parseSource` of a language in `FLAT_TREE_LANGUAGES` copies the tree once into typed arrays and returns `FlatNode`s ([parsers/flat-tree.ts](../parsers/flat-tree.ts)). A language joins the set only when its corpus output is byte-identical on the flat copy and the real tree (`--stable-output`); `flat-tree.test.ts` holds every member equal to the real node, quirks included; `descendantForIndex` is not copied, so callers descend through `children`. A file whose real root says `hasError` while the copy does not reads the flag from the real nodes (`readErrorFlags`).
- **Scaling gate:** `cli/scripts/check-scaling.mjs` (CI `verify` job, about 20 s) analyzes generated TS/Python/Go sub-projects at N and 4N single-threaded and fails when (t(4N) − t(1 project)) / (t(N) − t(1)) / 4 exceeds 2.5 — a quadratic pass shows there, fixtures are too small; it prints both runs' stage timings on failure. Never spread a six-figure array into `splice`/`push`/`Math.max` (stack overflow) and never scan a file's whole text per call or per name (cache the answer per file, `httpResourceFile`, `mutatesCollection`).
- **Cheap gates:** substring-gate expensive subtree walks (`sourceText.includes("import(")` before walking for dynamic imports); whole-text regex gate before per-line rule loops, and a whole-text gate asked per call site is computed once per file; a pattern built from a name is built only after a substring test on that name passes; a per-line rule loop over a whole file first tests one alternation of the words every rule names and skips the line otherwise; index a body's identifiers once instead of testing every declared name against every line. A per-argument walk of the enclosing function is one walk per function building a name table, kept per tree in a `WeakMap`; a text blanker scans char codes and copies kept stretches by `slice`, never a per-character array.
