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
- A parser front end may state each call's arguments (`PatternCallName.args` → `CallInfo.argCount`/`argKinds`/`templateArgs`; C++ `cpp/antlr.ts`): `callRecorder` then keeps one row per distinct (name, count, kinds, template arguments) in a function instead of one per name, so `g(1); g(1.0);` are two calls. The manifest's `calls.overloadTypeKey` folds declared types (`cpp/arg-kinds.ts`), `calls.conversionRanks` makes core rank exact > promotion > conversion (`argFit`'s `ranked` scale), and `calls.explicitSpecializations` has `convert<int>(x)` choose the definition whose `FunctionInfo.specializedOn` names those arguments. Core's `pickOverloads` reads a call's site from the link's own file only. An argument naming a variable is `@name` — also `*name` (a dereferenced pointer) and `this->name` (a field); core types it from the parameters, typed locals, `auto c = Club(3)` (a local whose one initializer is a construction of a class the project declares) and the class's fields.
- An extension several languages share (`.h`) has one owner, but how it is READ can depend on its sub-project: the
  owner's manifest `readingVariant(relativePath, mix)` gets the project's file counts by extension and names a
  variant (the C++ plugin: `c-first` for a `.h` in a project with `.c` and no C++ source) that its `meta.antlr` reader
  receives as a second argument. The analyzer counts the mix once, passes the variant in `FileTask.reading` (workers
  never see the mix) and folds it into the file's manifest `resolver` stamp, so a project whose mix flips re-reads
  its headers although no byte changed. `FileAnalysis.frontEnd.variant` records it.

## Conventions

- **One folder per language.** Even tiny regex specs (24 lines) get their own folder for consistency.
- **Visibility defaults matter.** Java/C# methods default to package-private (isExported=false unless explicitly `public`). Kotlin/TS default to public.
- **Decorators keep their arguments.** `decorators: string[]` holds the attribute/annotation text with its argument list (`Authorize(Policy = nameof(X))`, `ApiVersion("2", Deprecated = true)`), whitespace collapsed — that is where routing, auth and serialization semantics live. Consumers match with a regex or `includes`, never equality on a bare name. (Java's `extractAnnotations` still keeps the name only — a known gap.)
- **Route metadata is language-agnostic.** A route extractor that can see guards, API versions or parameter bindings fills `RouteInfo.middleware` (readable guard strings), `auth`, `versions`/`deprecatedVersions` and `params` — the same fields whatever the framework spells them as — through `shared/route-metadata.ts` (`GuardAttr`, `applyRouteMeta`, `inferredParam`). `csharp/routes/aspnet.ts` and `java-kotlin/routes/meta-annotations.ts` are the references: class-level attributes are inherited by every action, an anonymous marker waives, `[MapToApiVersion]` narrows, and a binding derived from framework defaults is marked `inferred: true`.
- **A Next.js `middleware.ts` / `proxy.ts` is a guard** only when its code checks the caller (a caller-check default-export name, a library wrapper, or a session/token read plus a redirect/401): `javascript/routes/next-middleware.ts` emits a `next-middleware` route fact with its `config.matcher` (none = all; an unreadable or `has`/`missing`-conditioned matcher guards nothing) and a resolver gives the matching Next routes of the same sub-project an inherited guard. A header-only middleware guards nothing.
- **Handlers declared elsewhere.** Express, Laravel, Rails, Go, Vapor, Phoenix… register a route by naming a handler whose signature the route line never shows. The extractor still sets `handler`; the plugin supplies what the handler READS (`FunctionInfo.requestAccess`, via the regex spec's `extractRequestAccess` or the AST extractor) and, for typed signatures, `meta.requestSchema.bindParam`. `core/request-schemas.ts` (`attachHandlerParams`) resolves the handler by name (same file → same sub-project → project-wide unique) and fills `params` from both. Never look a handler up from a per-file extractor. Name a handler `Class.method` (Play, Grails, Phoenix) when the route names its class: the linker then binds it only to that class's method (a namespaced `MyAppWeb.UserController` counts) and never, by name alone, to a same-named method of another class — an action the class lacks stays unresolved.
- **Gem-supplied controller actions (Rails).** A controller override that calls `super` records a call named `super`; the route anchor (`ruby/route-anchor.ts`) then gives its route the gem action's model access (Administrate CRUD by the controller's name), and a `mount_devise_token_auth_for 'Model'` route carries a `rails-devise-model` route fact (the model and the access its gem action has) that anchors the same way when the mapped model is one class of the project. `devise_for :players` draws the routes of the modules the model's own `devise :…` line enables (on the model or an ancestor; `ruby/devise-routes.ts` joins the router's `rails-devise-for` fact with the model's `rails-devise-modules` one) — nothing for a model whose `devise` line the project does not state. A concern's bare verbs (`update!` in a `module X; extend ActiveSupport::Concern`) carry `DataSourceInfo.mixinSelf`: inside a method core binds them to the model each resolved call runs on (`core/mixin-self.ts` — a route's `model.update_badges` through the controller's typed reader keeps that model as the call's `receiverType`), and an untyped call binds none; in the concern's body (an `included do` callback) the entity pass makes them one row per including model. A concern's `model.member` call through a memoizing reader (`def model; @model ||= @x; end`) becomes the call of the model's member when `@x` is typed where it is assigned (a model constant, a one-target association, through other variables); `ClassInfo.fieldValues` also holds a variable assigned another variable (`@a`).
- **Regex-path attributes.** A spec's `attributeLine` turns own-line attributes (`#[serde(rename = "x")]`, `<Required>`, `@Field(key: "x")`) into `decorators` on the function, class or property below them; inline tags (Go `json:"x"`) belong in the property pattern's `build`.
- **Request-schema hooks.** A plugin whose language has typed request models exposes `meta.requestSchema` (`unwrapNullable`, `describeType`, `serializedName`, `isSerialized`, `isRequired`, see `csharp/request-schema.ts`). The core pass in `core/request-schemas.ts` does the class lookup, inheritance flattening and recursion; the hooks only say what one type text means and what one property is called on the wire.
- **Reachability (dead code).** `meta.reachability` opts a language into dead-code judgement: `load()` reads the toolchain config once and returns the model core walks (entries by manifest and by convention, specifier → files, path references, template tags). Gate framework directory conventions (`pages/`) on the framework id so a plain SPA's dead page is still found, keep every other doubt on the "reached" side, and leave the hook unset for languages that find files by namespace/autoload. `javascript/reachability.ts` is the reference; `javascript/path-references.ts` is its per-file half (glob imports, worker URLs, config-file script paths → `FileAnalysis.pathReferences`). `rust/reachability.ts` (module tree; `mod:`/`path:` references via the regex spec's `extractPathReferences`) and `python/reachability.ts` (`__main__`, `module:`/`file:` references) follow the same shape. `pathReferences` is plugin-private dialect: only the plugin's own model reads it. Split conventions into `entryReason` (where the program starts — anchors a project) and `passiveReason` (run by a tool or instantiated by a framework — configs, migrations, scripts, `[ApiController]`s, `@Component`s): a project anchored only by a migration or a DbContext would have every other file reported. Most languages need no bespoke model: `<lang>/reachability.ts` is a `conventionReachability({...})` spec (shared/reachability-kit.ts) — extensions, `importPath`, which names a file declares, entry files / `main` / `@main`-style source patterns, framework attributes and base types (passive), config files whose identifiers name entries, and an `extend` hook for load-time rules (a Go module path, a gem's `lib/` as public API). C, C++ and Objective-C share one instance (shared/c-family-reachability.ts).
- **Dependency injection: report facts, never resolve.** Core (`core/symbol-linker.ts`) decides which implementation an injected receiver reaches; a plugin supplies the declared types (as written), injection-point `qualifier`s, constructor params, `localTypes` (typed locals and container lookups), `CallInfo.receiverType` for a lookup chained into a call (`calls.receiverTypeOf` / regex `callPatterns` `buildName → receiverType`), `kind: "interface"` (+ `structural`), `abstract` on an abstract class and on each bodyless abstract method (core dispatches through them as through interfaces), every implemented interface as its own `implements` entry, and container registrations as `diBindings` (`ast.diBindings` / `RegexLangSpec.extractDiBindings`). A `@Profile` naming a constant (`PROD`, `Profiles.PROD`, inside a list or a concatenation) is a `${…}` hole in `conditional.profiles`, which core's `resolveBindingConditions` (module-values pass) fills; a list with a name nothing states keeps the bare `Profile` condition. Emit every registration the source states, conditional ones included — core refuses to choose between disagreeing ones. Store the array `extractCalls` returns as-is (append in place): it carries the noise-named calls (`repo.find`) the per-file pipeline restores for typed receivers.
- **Doc comments.** `manifest.docComments` (a `DocCommentSpec` — line prefixes, block delimiters, `docstring`, the attribute lines that may sit between, `blockLead` for a block opened by a lead such as Elixir `@doc """`, `pod` for Perl `=head`…`=cut`, `moduleDocInside` for a module doc read from inside its body, `caseInsensitive` for batch `REM`) is all a language supplies — on the manifest, since MCP tools read it with no plugin body loaded; `core/doc-comments.ts` reads the first sentence above each function, method and class (or the docstring opening its body) into `doc`. Shared shapes: `extractors/shared/doc-comment-specs.ts`.
- **Alias of a typed local (`LocalType.aliasOf`).** A name assigned from another plain name — `const q = p`, Go `q := p` / `&p`, PHP `$q = $p`, C++ `auto& q = p` / `= *p`, Rust `let q = p` / `&p`, Python `q = p` and `(q := p)` — is a `localTypes` entry with `type: ""` and `aliasOf: "p"` (no `from`); core types it through `scopedName(aliasOf, depth + 1)` under the same `MAX_INITIALIZER_DEPTH` cap as initializer calls. The plugin emits it only when the name is bound ONCE, from ONE head, and never reassigned, rebound by a loop/`catch`/`foreach`/destructuring or shadowing a parameter (each plugin checks its own language's forms); everything else stays untyped, so an alias of an untyped name links nothing and a namesake method on another class is never reached. Never an alias: `undefined`, `true`/`false`, `nil`/`nullptr`, `self`/`this`. A Python parameter-typed alias is read by the fact table already; `aliasOf` is for a head typed by a call (`p = make(); q = p`). The Python local-type gate skips an alias-only body unless a parameter is annotated.
- **Bindings a body states without a declaration.** A loop variable, a lambda parameter, a narrowed name (`instanceof X x`, `is X`, `if let`, a type switch, `isinstance`), a caught exception or an element read (`list.get(0)`, `m[k]`) is reported as a `localTypes` entry whose `from` names what it is drawn from, or as `CallInfo.receiverType` on the call; core resolves it as it resolves any initializer. JVM and .NET share the chain reader in `shared/element-chain.ts`; tuple unpacking from an annotated return uses `localTypes[].fromIndex` with the manifest's `tupleElementsOf`. Two element types for one name leave it untyped. A `from` may be a chain of calls (Go `club.Address().City()`, Swift `garage.car().engine()`; `Type.init(…)` is a construction of `Type`); a destructured member read off a value or a method's result (`const { coach } = club.staff()`, `= club`) is `localTypes[].member` with `from` = `club.staff().coach`, written only where the body calls on the name; a C++ `auto [a, b] = pairOf()` is `fromIndex` entries typed by the manifest's `tupleElementsOf` (`std::pair`/`std::tuple` returns; a struct return stays untyped). Loops over a call chain or a typed collection: Go `range` over a chain of calls and fields (`league.Club(1).Players()`), PHP `foreach` (a call or property chain as `from`/`element`, a parameter or `@var` local typed by `Player[]`/`array<int, Player>` — a native `array` result with a docblock `@return Player[]` keeps the docblock in `declaredReturnType`), C++ range-for with `auto` (a container-typed name takes its element in the plugin; a call or field goes to the linker; `cpp/collection-element.ts`), Rust `for` over a field or call (`rust/collection-element.ts`), Kotlin `for ((club, player) in map)` / `.keys` / `.withIndex()` (`ChainRules.keys`, `ElementState.key`), Python `for i, (a, b) in enumerate(pairs)` / `.items()` over `list[tuple[A, B]]` / `dict[A, B]` (`rowShape`). An element type the source does not state leaves the variable untyped. A type test narrows PER CALL, never the name: `CallInfo.receiverType` is set only on calls inside the region the test guards — TS/JS `instanceof` ([javascript/narrowing.ts](javascript/narrowing.ts): the true branch, the else of a negated test, the rest of the block after an early `return`/`throw` guard, `&&` and `?:`), C# `is` ([csharp/type-tests.ts](csharp/type-tests.ts), also `is not`), Python `match` class patterns (`case Club():`, `as`, `|` alternatives), Kotlin `when (x) { is A -> …; is B -> … }` (each arm its own type) — and a call outside it, a callback body or after the name is reassigned gets none. The linker keeps ONE link per caller and call name, so a second arm calling the same method name adds none.
- **Smaller hooks.** `calls.isApiCallShape(callName, imports)` marks a call shape that is an api-call whatever its receiver (tRPC `.query`/`.mutate`); `calls.withSubjectsOf` names the implicit receivers a bare call may run on (Delphi `with`, Kotlin `with`/`apply`); `PreprocessOutcome.restoreTypedCalls` asks for noise-named calls to be restored again after a `postExtract` that created their class (Lua tables). Regex specs: `extractParams` (a declaration's parameters where `extractParamsFromLine` misreads them), `extractModuleBindings` (package-level values a later call reads — Go package vars, Dart top-level variables, Ruby top-level `NAME = Foo.new` constants, which the manifest's `moduleBindingsFollowImports` makes visible to the files that `require` it, a few files deep), `extractChannelBindings` (a socket's `channel "topic:*", Module` → `FileAnalysis.channelBindings`). A route resolver with `afterMounts: true` runs after router mounts and base paths are composed.
- **Declared facts a manifest opts into (1.618.0).** `collectionElementOf(type)` reads the element of a declared
  collection (`Club[]`, `list[Club]`, `[]*Club`, `[Club]`) for a loop or callback local the plugin reports as
  `localTypes[{ from, element: true }]`; `nestedTypeSeparator` (`.` or `::`, default `::`) and `nestedTypesScopeBare`
  name nested types by path; `constructorCalls` (`init`, `new`) are sends that construct their receiver class;
  `indexerMethod` (Kotlin `get`) reads `x[i].m()` as `x.get(i).m()`; `bareMembersHideFunctions` makes a class's
  member win a bare call inside the class over a same-named free function; `importsDeclaredPackages` resolves a
  dotted import by the package a file declares (`ast.packageName`) before its directory; `compilationDatabase` names
  the compile database files at a project root (`-I` order and `-D` macros reach `read(source, macros)`);
  `PackageManifestSpec.projectReferences` returns the sibling projects a build file declares
  (`SubProject.references`; a reference may name a package — `ProjectReference.package`, npm `workspace:` — resolved to the one sub-project of that ecosystem declaring it); `preprocessStamp(absolutePath, projectRoot)` fingerprints what a `preprocess` reads
  beside the file (its `PreprocessContext`) so `--incremental` notices it; `regexControlFlow.sourceView` gives the
  control-flow scanner the compiler's view of a body. Regex specs: `extractReExports` (a barrel's `export 'x'`);
  `ImportInfo.inScope.except` (names an import keeps out of scope); `DataSourceInfo.topicSyntax: "mqtt"` (JS, Python paho/aiomqtt, Java/Kotlin Paho/HiveMQ, Go paho, C# MQTTnet) joins a
  publish to the `+`/`#` filters that cover it.
- **Line numbers are 1-based** in all output.
- **No cross-plugin imports** — if two plugins need the same logic, extract it to `../shared/` or `shared/regex-base.ts`.

- **A parser front end misses declarations that construct; a package can be the scope.** `RegexLangSpec.declarationCallPatterns` lists call patterns read over each PARSED function's lines (after the grammar's own calls, never the baseline `name(`), adding what the parse did not name there — C++ `Rank::Iterator it(2);` is a declaration to the grammar and the constructor call to the linker; without a front end `callPatterns` carries the same pattern. A C++ class path keeps its lowercase namespace on the call's `receiverType` (`league::Table::make()`), which core resolves against `ClassInfo.namespace`, so a namesake in another namespace is never taken. The manifest's `packageScope` (Kotlin, with `directoryScope`) makes the declared `package`, not the folder, the scope: same-package files in any folder of the sub-project share top-level functions, and a bare class name is the one its own package declares.
- MQTT topics held in names: a topic argument that is a constant of the file (declared once) reads as its value; a name a project module exports (JS imports, Python `from … import`, Go exported `pkg.Name`, Java/Kotlin `Type.NAME`, C# `Type.Name`) is a row with `target: null` + `targetRef`, which core's module-value pass fills; a lowercase variable or parameter names no topic. Python's `subscribe([("a", 0)])`, Go `SubscribeMultiple(map…)`, Java `new String[]{…}` and Kotlin `arrayOf` give one row per topic.
