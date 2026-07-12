# src/extractors — Per-language extraction

Everything that walks an AST or regex-scans source text to pull out structured data. Cross-file analysis is `src/core/`'s job — with one deliberate exception: a plugin may contribute a **project-level reconciliation** pass (`EntityExtractor.reconcileProject`) for a join that needs both language knowledge AND the whole file set (e.g. Rails joining `db/schema.rb` columns onto its models). Core invokes these generically — language-specific cross-file logic still belongs in the plugin, never in core.

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
- `grammar` (tree-sitter wasm location + per-file variant selection), `regexSpec` (RegexLangSpec), `customParse` (dedicated parsers like .dfm), `preprocess` (container formats like Vue SFC)
- `builtinTypes`, `externalModulePrefixes`, `externalNamespaceRoots` — import/type-resolution data
- `complexity` (branch nodes / logical ops), `securityRules` (+ `securityPreprocess`/`securityPostScan`/`skipSecurityScan`)
- `frameworkImportHints`, `apiCallRoots`, `dbCallRoots`
- `ast` hooks: `typeReferences`, `interactiveElements`, `subComponents`, `events`, `variableAliases`
- `calls` hooks: `callNodeTypes`, scope/callback node types, name resolution, auto-imported classification

**Two tiers.** Each plugin also has a `manifest.ts` — the STATIC tier
(`LanguagePluginManifest`): extensions, parsing kind, grammar location,
test-file patterns, external prefixes/roots, builtin members, framework
import hints, `frameworks.ts` rules, `activationFiles`, `dispatchLanguages`.
The registry imports every manifest EAGERLY and builds the module-scope
constants from them (`EXTENSION_TO_LANGUAGE`, `STRIP_SOURCE_EXTENSION_RE`,
`ALL_EXTERNAL_MODULE_PREFIXES`, `EXTERNAL_NAMESPACE_ROOT_RE`,
`ALL_BUILTIN_MEMBERS`, `FRAMEWORK_RULES`, `testFilePatternsFor`,
`inferFileFrameworks`). Manifests are leaf modules: types + the plugin's
`frameworks.ts` only. Each meta spreads its manifest so static fields have one
source of truth.

The metas (LAZY tier) sit behind a static thunk map (`LOADERS`) of dynamic
imports — tsup's ESM code splitting emits one chunk per plugin. `await
ensureLanguagesLoaded(langs)` (or `loadAllPlugins()`) populates `pluginFor`;
the analyzer calls it after file discovery with the discovered languages ∪
`ACTIVATION_FILE_LANGUAGES` hits (go.mod → go, …) ∪ dispatch couplings
(`manifest.dispatchLanguages` — a vb project loads csharp so its UI-bridge
resolver runs). `analyzeFile` self-activates per file as a safety net.
`pluginFor` THROWS for a registered-but-unloaded language (silent undefined
would quietly degrade extraction); vitest loads everything via
`src/test-setup.ts`. Lazy-tier accessors: `pluginFor`, `astHooksFor`,
`complexityFor`, `regexSpecFor`, `securityRulesFor`, `classifyKnownPackage`
(rebuilt from loaded metas in manifest order), `allPluginMetas` (loaded metas,
manifest order).

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

| File | Purpose |
|------|---------|
| [call-graph.ts](shared/call-graph.ts) | `extractCalls(body, language)` — main function-call walker. `classifyCalls(calls, imports, lang)` — sets `kind` to `cross-file`/`internal`/`api-call`/`database`. `extractVariableAliases` — `const s = useStore()` → maps `s` to import source |
| [call-patterns.ts](shared/call-patterns.ts) | `isApiCall(name)`, `isDatabaseCall(name)` — pattern matchers used by `classifyCalls`. Per-language root lists come from plugin metas via the registry. |
| [link-scoring.ts](shared/link-scoring.ts) | `buildLinkGraph(analyses)` — file → file edges with proximity (1=tight, 2=medium, 3=loose). `resolveTarget(importSource, sourceFile, filePathMap)` — turns `"./foo"` or `"com.example.Foo"` into a file path. `buildFilePathMap` — index for fast resolution. External-package prefixes come from plugin metas via the registry. |
| [node-helpers.ts](shared/node-helpers.ts) | Tree-sitter AST utilities: `getVisibility`, `getNameFromNode`, `getCallName`, `extractJsDecorators`, `extractAnnotations`, `extractCsharpAttributes`, `extractPythonDecorators` |
| [builtin-types.ts](shared/builtin-types.ts) | `isBuiltinType(name, language)` — per-language deny sets come from plugin metas via the registry; exports `COMMON_PRIMITIVES` as the base for plugin sets. |
| [type-ref-helpers.ts](shared/type-ref-helpers.ts) | Shared helpers for the per-plugin `type-references.ts` walkers (`emitParsed`, `findChildByType`, `lineOf`) |

Language-specific extractors that used to live here moved into their plugins:
`interactive-elements.ts`, `sub-components.ts`, `events.ts` →
`plugins/javascript/`; `python-tokenizer.ts` → `plugins/python/`;
the per-language type-reference walkers → `plugins/<lang>/type-references.ts`.
They're wired into the pipeline through each meta's `ast` hooks.

## routes/

Same registry pattern as the other domains: `routes/base.ts` defines
`RouteExtractor` (`languages` + `extractRoutes(tree, sourceText)`), and each
language family exports one:
- `javascript/routes/index.ts` — runs Express, React Router, NestJS, Vue Router in order
- `python/routes.ts` (Flask, FastAPI, Django)
- `csharp/routes/aspnet.ts`
- `java-kotlin/routes/spring.ts`
- `pascal/routes.ts`

Regex-path languages (Go, Ruby, PHP) extract routes inside their `plugins/<lang>/index.ts` via `RegexLangSpec.extractRoutes`.

## entities/ (ORM entities + relations)

`entities/base.ts` defines `EntityExtractor`; each plugin subclasses it in
`plugins/<lang>/entities.ts` and wires the instance as `meta.entities`. Two surfaces:

- **`extract(ctx)`** — per file: emit entity `ClassInfo`s (merged into
  `analysis.classes` by name) + `EntityRelation`s. This is where the bulk of
  ORM detection lives.
- **`reconcileProject(analyses)`** — optional project-level pass run once over
  the whole file set (core calls `reconcileProjectEntities`, which invokes every
  extractor's pass). Use it for a join that genuinely needs both language
  knowledge and all files at once — e.g. the Ruby plugin parses `db/schema.rb`
  during `extract` (stashing tables on `FileAnalysis.railsSchemaTables`) and
  then, in `reconcileProject`, attaches those columns to the model entities that
  live in other files. Keep the language-specific logic here in the plugin;
  core only knows the generic hook.

## Conventions

- Extractors return **raw extractions** — call classification (internal vs cross-file) happens in `classifyCalls()` after extraction
- Line numbers are **1-based** in output (tree-sitter is 0-based — convert: `node.startPosition.row + 1`)
- Extractors should never call each other directly; they communicate via `FileAnalysis` fields
- Noise filtering (skip `console.log`, `.map`, `.filter`, etc.) is centralized in `call-graph.ts` `NOISE_CALLS`
