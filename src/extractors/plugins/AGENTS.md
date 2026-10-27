# src/extractors/plugins — Per-language implementations

Each language gets one folder. Two patterns are used depending on whether the language has a working tree-sitter grammar:

## Tree-sitter plugins (AST-based)

Folders: `javascript/`, `python/`, `java-kotlin/`, `csharp/`, `pascal/`

Contents (varies slightly per language):
```
<lang>/
├── manifest.ts               LanguagePluginManifest — STATIC tier (extensions, grammar, patterns, framework rules), eagerly aggregated
├── meta.ts                   LanguagePluginMeta — LAZY tier (spreads the manifest + hooks/extractors), loaded via registry LOADERS
├── frameworks.ts             FrameworkRule[] — manifest-level framework detection for the ecosystem (optional)
├── functions-classes.ts      extends FunctionClassExtractor
├── imports-exports.ts        extends ImportExportExtractor
├── data-sources.ts           extends DataSourceExtractor (optional)
├── data-mutations.ts         extends DataMutationExtractor (optional)
└── routes/                   framework-specific route extractors (optional)
```

Each extractor class implements `abstract collectFunctions(node, results)` / `collectClasses` / `collectImports` / etc. using tree-sitter AST walking. Instances are carried on the plugin's meta (`meta.functionsClasses`, `meta.importsExports`, `meta.routes`, `meta.dataSources`, `meta.dataMutations`, `meta.entities`, `meta.dispatchResolvers`, `meta.routeResolvers`) — the domain `src/extractors/<category>/index.ts` files dispatch via `pluginFor(language)` and import no plugin code. Family plugins share ONE instance across member metas (instance identity = run-once in project-level passes like `reconcileProjectEntities`); dispatch resolvers carry a `priority` that fixes cross-plugin link order.

## Regex plugins (source text–based)

Folders: `go/`, `rust/`, `ruby/`, `php/`, `swift/`, `lua/`, `scala/`, `dart/`

Contents:
```
<lang>/
├── meta.ts     LanguagePluginMeta — builtins, extensions (from the spec), parsing: "regex"
└── index.ts    exports a RegexLangSpec
```

The `RegexLangSpec` declares:
- `functionPatterns` — regex + isExported/isAsync predicates
- `classPatterns` — regex + extends extractor
- `importPatterns` — regex + source/specifier extractors
- `indentBased` — true for Ruby/Lua, false for brace languages
- `lineCommentPrefixes` — `["//"]`, `["#"]`, `["--"]`, etc.
- `extractRoutes` (optional) — custom route extraction for frameworks like Rails controllers, Go muxers, Laravel attributes

The shared framework in [shared/regex-base.ts](shared/regex-base.ts) handles:
- Walking lines, matching patterns
- Finding end-of-block (braces or indentation)
- Extracting params, properties, calls from bodies

Specs are loaded by [../../core/regex-extractor.ts](../../core/regex-extractor.ts).

## shared/

[shared/regex-base.ts](shared/regex-base.ts) — the `RegexLangSpec` type and the generic `extractFunctionsWithSpec` / `extractClassesWithSpec` / `extractImportsWithSpec` / `extractCallsFromBody` helpers used by all regex plugins.

[shared/brace-code.ts](shared/brace-code.ts) — a brace language's literal forms (`BraceLexicon`: comments, strings, raw strings, character literals) and the spec hooks built from them (`braceCodeHooks`): `blockEnds` counts braces over code only, `callSourceLines` blanks raw strings and block comments for the call scan, `commentFreeLines` is what a route scan reads, `startsInCode` keeps a function pattern out of comments and code templates. Go, Rust, C, C++, Scala and Swift use it (Scala with blocks that end by braces or indentation, `scala/blocks.ts`; C and C++ through [shared/c-family-code.ts](shared/c-family-code.ts), which also says when a signature is a definition); [shared/call-chains.ts](shared/call-chains.ts) names a method called on a call's result as the chain (`Club.new().register`).

[shared/project-info-queries.ts](shared/project-info-queries.ts) — `hasDep` / `hasGoMod` / `hasCsprojPackage` / … predicate helpers over `ProjectInfo` for `frameworks.ts` rules.

[shared/handler-taint.ts](shared/handler-taint.ts) — request input followed through ONE request handler to a sink (SQL text, command, file path, outbound URL, redirect, eval), the plugin's `ast.taint` hook. The algorithm is here; a plugin supplies a `TaintSpec` (what a handler is, the request-input regex, assignment/call shapes, sanitizers, propagators — the calls whose RESULT carries their arguments' taint; any other function's result is not followed — and sinks with the argument that carries the danger). Python (`python/taint.ts`) and JS/TS (`javascript/taint.ts`) have one. A guard (`startsWith`, `safe…(`, `valid…(` on the value in an `if`) counts as a check. Measured on five real repositories: zero findings, after 16 false ones drove the propagator, guard and free-text-parameter rules — precision first, every finding is an accusation.

[shared/security-context.ts](shared/security-context.ts) — `CREDENTIAL_CONTEXT`, the lookahead that keeps an MD5/SHA-1 rule to lines about a credential.

## Framework detection (frameworks.ts)

Manifest-level framework rules live with the plugin that owns the ecosystem —
`plugins/<lang>/frameworks.ts` exports `FrameworkRule[]`, wired via
`meta.frameworkRules` and aggregated by the registry into `FRAMEWORK_RULES`
(duplicate ids throw at registry build). `core/framework-detector.ts` only
gathers `ProjectInfo` and runs the rules; it knows no framework names, exactly
like `knownPackages`. Notes:

- Rule `check` predicates compose the helpers in
  [shared/project-info-queries.ts](shared/project-info-queries.ts).
- Detections are sorted by id in the detector, so output never depends on
  plugin registration order.
- Family plugins (javascript, java-kotlin, pascal) attach rules to ONE member
  meta only (typescript/java/pascal) so the registry sees each rule once.
- Cross-cutting rules live with the plugin that owns the file format:
  `qt` → cpp, `qt-quick` → qml, `sql` → sql, `jsp` → jsp,
  `spring-webflow` → springxml, `prisma` → prisma.
- Vendored frameworks with no manifest entry (CodeIgniter 2/3) declare
  `meta.markerCandidates` — well-known relative paths collected into
  `ProjectInfo.markerFiles` for rules to match on.

## Adding a new language

### Tree-sitter path (preferred when grammar is available)

1. `npm install tree-sitter-<lang>` (or verify WASM is in a deps package)
2. Add to `Language` type in [../../types/analysis.ts](../../types/analysis.ts)
3. Create `src/extractors/plugins/<lang>/` with per-category extractors
4. Wire each extractor instance onto the meta (`functionsClasses`, `importsExports`, `routes`, `dataSources`, `dataMutations`, `entities`, `dispatchResolvers`, `routeResolvers`)
5. Create `manifest.ts` (the STATIC tier: `language`, `family` — the import-resolution family, shared by languages that resolve each other's bare names (`jvm`, `dotnet`, `cfam`, `script`), else the language's own — `parsing`, extensions (one owner each: the registry throws on a second claim), `grammar` — package + wasm location, with optional per-file variant selection like tsx — test patterns, prefixes/roots, framework hints, `activationFiles`) and `meta.ts` (spreads the manifest, then adds builtins, complexity tables, security rules, ast hooks, and `calls` — at minimum `callNodeTypes`, plus name-resolution/scope hooks as needed; see `call-hooks.ts` in existing plugins). Register the manifest in `ALL_MANIFESTS` and the meta in `LOADERS` in [../registry.ts](../registry.ts) — extensions, discovery, grammar loading, complexity, call extraction, and the rest flow from there
6. If the ecosystem has detectable frameworks, add `frameworks.ts` (`FrameworkRule[]`) and wire `manifest.frameworkRules` (see "Framework detection" above)

### Regex path (languages without reliable grammar)

1. Add to `Language` type in [../../types/analysis.ts](../../types/analysis.ts)
2. Create `src/extractors/plugins/<lang>/index.ts` exporting a `RegexLangSpec`
3. Create `manifest.ts` (`parsing: "regex"`, `family`, `extensions` — the same list as the spec's) and `meta.ts` (spreads the manifest, `regexSpec: <spec>`, builtins), and register both in [../registry.ts](../registry.ts)
4. A script language whose files run their own statements sets the spec's `topLevelCalls` (`true`, or a path RegExp — VB sets it for `.vbs` only): calls outside every function/class become the `<setup>` pseudo-function. A top-level block that only REGISTERS code to run later (`get "/x" do … end`, `before_all do`) is listed by `deferredBlocks` so `<setup>` skips its body.

### Container formats (e.g. Vue SFC, Delphi .dfm)

- A format that embeds another language (Vue) declares `preprocess` on the host
  language's meta — swap in the embedded source/language before parsing, and
  optionally merge container data back via `postExtract`.
- A format with its own parser (.dfm) declares `parsing: "custom"` + `customParse`.

## Conventions

- **One folder per language.** Even tiny regex specs (24 lines) get their own folder for consistency.
- **Visibility defaults matter.** Java/C# methods default to package-private (isExported=false unless explicitly `public`). Kotlin/TS default to public.
- **Decorators keep their arguments.** `decorators: string[]` holds the attribute/annotation text with its argument list (`Authorize(Policy = nameof(X))`, `ApiVersion("2", Deprecated = true)`), whitespace collapsed — that is where routing, auth and serialization semantics live. Consumers match with a regex or `includes`, never equality on a bare name. (Java's `extractAnnotations` still keeps the name only — a known gap.)
- **Route metadata is language-agnostic.** A route extractor that can see guards, API versions or parameter bindings fills `RouteInfo.middleware` (readable guard strings), `auth`, `versions`/`deprecatedVersions` and `params` — the same fields whatever the framework spells them as — through `shared/route-metadata.ts` (`GuardAttr`, `applyRouteMeta`, `inferredParam`). `csharp/routes/aspnet.ts` and `java-kotlin/routes/meta-annotations.ts` are the references: class-level attributes are inherited by every action, an anonymous marker waives, `[MapToApiVersion]` narrows, and a binding derived from framework defaults is marked `inferred: true`.
- **Handlers declared elsewhere.** Express, Laravel, Rails, Go, Vapor, Phoenix… register a route by naming a handler whose signature the route line never shows. The extractor still sets `handler`; the plugin supplies what the handler READS (`FunctionInfo.requestAccess`, via the regex spec's `extractRequestAccess` or the AST extractor) and, for typed signatures, `meta.requestSchema.bindParam`. `core/request-schemas.ts` (`attachHandlerParams`) resolves the handler by name (same file → same sub-project → project-wide unique) and fills `params` from both. Never look a handler up from a per-file extractor. Name a handler `Class.method` (Play, Grails, Phoenix) when the route names its class: the linker then binds it only to that class's method (a namespaced `MyAppWeb.UserController` counts) and never, by name alone, to a same-named method of another class — an action the class lacks stays unresolved.
- **Regex-path attributes.** A spec's `attributeLine` turns own-line attributes (`#[serde(rename = "x")]`, `<Required>`, `@Field(key: "x")`) into `decorators` on the function, class or property below them; inline tags (Go `json:"x"`) belong in the property pattern's `build`.
- **Request-schema hooks.** A plugin whose language has typed request models exposes `meta.requestSchema` (`unwrapNullable`, `describeType`, `serializedName`, `isSerialized`, `isRequired`, see `csharp/request-schema.ts`). The core pass in `core/request-schemas.ts` does the class lookup, inheritance flattening and recursion; the hooks only say what one type text means and what one property is called on the wire.
- **Reachability (dead code).** `meta.reachability` opts a language into dead-code judgement: `load()` reads the toolchain config once and returns the model core walks (entries by manifest and by convention, specifier → files, path references, template tags). Gate framework directory conventions (`pages/`) on the framework id so a plain SPA's dead page is still found, keep every other doubt on the "reached" side, and leave the hook unset for languages that find files by namespace/autoload. `javascript/reachability.ts` is the reference; `javascript/path-references.ts` is its per-file half (glob imports, worker URLs, config-file script paths → `FileAnalysis.pathReferences`). `rust/reachability.ts` (module tree; `mod:`/`path:` references via the regex spec's `extractPathReferences`) and `python/reachability.ts` (`__main__`, `module:`/`file:` references) follow the same shape. `pathReferences` is plugin-private dialect: only the plugin's own model reads it. Split conventions into `entryReason` (where the program starts — anchors a project) and `passiveReason` (run by a tool or instantiated by a framework — configs, migrations, scripts, `[ApiController]`s, `@Component`s): a project anchored only by a migration or a DbContext would have every other file reported. Most languages need no bespoke model: `<lang>/reachability.ts` is a `conventionReachability({...})` spec (shared/reachability-kit.ts) — extensions, `importPath`, which names a file declares, entry files / `main` / `@main`-style source patterns, framework attributes and base types (passive), config files whose identifiers name entries, and an `extend` hook for load-time rules (a Go module path, a gem's `lib/` as public API). C, C++ and Objective-C share one instance (shared/c-family-reachability.ts).
- **Dependency injection: report facts, never resolve.** Core (`core/symbol-linker.ts`) decides which implementation an injected receiver reaches; a plugin supplies the declared types (as written), injection-point `qualifier`s, constructor params, `localTypes` (typed locals and container lookups), `CallInfo.receiverType` for a lookup chained into a call (`calls.receiverTypeOf` / regex `callPatterns` `buildName → receiverType`), `kind: "interface"` (+ `structural`), every implemented interface as its own `implements` entry, and container registrations as `diBindings` (`ast.diBindings` / `RegexLangSpec.extractDiBindings`). Emit every registration the source states, conditional ones included — core refuses to choose between disagreeing ones. Store the array `extractCalls` returns as-is (append in place): it carries the noise-named calls (`repo.find`) the per-file pipeline restores for typed receivers.
- **Doc comments.** `meta.docComments` (a `DocCommentSpec` — line prefixes, block delimiters, `docstring`, the attribute lines that may sit between) is all a language supplies; `core/doc-comments.ts` reads the first sentence above each function, method and class (or the docstring opening its body) into `doc`. Shared shapes: `extractors/shared/doc-comment-specs.ts`.
- **Line numbers are 1-based** in all output.
- **No cross-plugin imports** — if two plugins need the same logic, extract it to `../shared/` or `shared/regex-base.ts`.
