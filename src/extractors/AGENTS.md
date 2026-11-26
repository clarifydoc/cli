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

[registry.ts](registry.ts) is the one place core asks about a language; its header comment states the two tiers
(static `manifest.ts` data imported eagerly, lazy `meta.ts` bodies behind `LOADERS`), the accessors and the no-cycle
rule. A plugin's `LanguagePluginMeta` ([../types/language-plugin.ts](../types/language-plugin.ts)) carries everything
language-specific, including the domain extractor instances (`functionsClasses`, `importsExports`, `routes`,
`dataSources`, `dataMutations`, `entities`, `dispatchResolvers`, `routeResolvers`; family plugins share one instance
across member metas) and the hook bundles — `ast`, `calls`, `complexity`, `securityRules`, `regexSpec`, `customParse`,
`preprocess`, `apiContract`, `schemaFormat`, ….

- `apiContract` (manifest) — the language describes an API rather than implementing it (OpenAPI, GraphQL SDL, WSDL, JSight, Protocol Buffers); `isApiContractLanguage()` is how core asks.
- `schemaFormat` (manifest) — the language's classes are data shapes (SQL tables, Prisma models, a Core Data model), never types code constructs or calls; with `apiContract` languages they make `declaresSchemaTypes()`, which keeps those classes out of the symbol linker's indexes and type catalogs (functions — a stored procedure, a named query — stay targets).
- Static data a tool reads on demand belongs on the manifest, never on the meta; manifests and metas are leaf modules (types, their own plugin code, leaf shared helpers — never core or the registry).
- **Adding a language**: `plugins/<lang>/` with the domain extractors, a `manifest.ts` + `meta.ts` (meta spreads the manifest), the manifest in `ALL_MANIFESTS` and the meta in `LOADERS`; full checklist in [plugins/AGENTS.md](plugins/AGENTS.md).

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
- `projectPasses` ([project-passes.ts](project-passes.ts)) — async passes that read what they need from disk and add to the analyses in memory, before the import index and the linker (routes a build plugin generates from a page folder, a component's `templateUrl` template).

Two per-file and static hooks serve the same rule: `ast.fileRoutes` gives the routes a file's place states
(file-based routing — Next.js, Nuxt, SvelteKit, Astro, Expo Router, flat routes), and the manifest's
`resolveImportByFiles` reads an import from the file set alone for core's generic `resolveImportSource`
(Python's dotted modules). A YAML/JSON document skeleton that plugins and core both read is
[shared/spec-document.ts](shared/spec-document.ts).

Each receives a `ProjectContext` ([../types/project.ts](../types/project.ts)):
the import index, a class index (`resolve`, `supertypes`, `ancestors`,
`descendants` — import-aware, refusing ties), `resolveModule` and `fileOf`.

The registry is only data plumbing: the module-scope constants it builds from the manifests and the lazy accessors are listed in its header comment.

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

Language-agnostic helpers are mapped in [shared/AGENTS.md](shared/AGENTS.md): `classifyCalls(calls, imports, lang)` sets each call's `kind` using `isApiCall(name)`/`isDatabaseCall(name)`; `buildLinkGraph(analyses)` and `resolveTarget(importSource, sourceFile, filePathMap)` turn imports (`"./foo"`, `"com.example.Foo"`) into file edges; `isBuiltinType(name, language)` reads per-language sets the registry pushes in. Language-specific extractors live in their plugins and are wired through each meta's `ast` hooks.

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

**Mount prefixes are a project-level pass, not a per-file one.** A route's real path often comes from a different
file (Express `app.use("/api/auth", authRoutes)`, FastAPI `include_router(auth.router, prefix="/users")`), so the
per-file extractor emits the mount as an api route marked `mount: true` (`httpMethod: null`, `handler` = the router
identifier) and [shared/router-mounts.ts](shared/router-mounts.ts) composes it after per-file analysis — what it
merges and why the marker is required are in that file's header. Emit a mount only when the prefix is a literal.
Getting this wrong is not cosmetic: `dedupeRoutes` keys on method+path, so several routers' un-prefixed
`@router.get("")` collapse into one endpoint.

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
