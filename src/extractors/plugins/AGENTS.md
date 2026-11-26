# src/extractors/plugins — Per-language implementations

Each language gets one folder. Two patterns are used depending on whether the language has a working tree-sitter grammar. This file holds what applies across languages; each folder's own `AGENTS.md` holds that language's facts. Read the language file before editing in its folder.

## Languages

Every folder below has an `AGENTS.md`. A folder without one keeps its facts in a sibling's file (or, for the few facts of erlang, clojure, jsight and wsdl, in this shared text).

| Folder | Facts |
|--------|-------|
| `apex/` | [Apex](apex/AGENTS.md) — Salesforce Apex, SOQL/DML, SFDX metadata |
| `applescript/` | [AppleScript](applescript/AGENTS.md) |
| `autohotkey/` | [AutoHotkey](autohotkey/AGENTS.md) |
| `autoit/` | [AutoIt](autoit/AGENTS.md) |
| `bash/` | [Bash](bash/AGENTS.md) |
| `batch/` | [Windows batch](batch/AGENTS.md) |
| `blazor/` | [Blazor](blazor/AGENTS.md) |
| `c/`, `cpp/` | [C](c/AGENTS.md), [C++](cpp/AGENTS.md) — `qml/` and `qtui/` facts are in the C++ file |
| `coffeescript/` | [CoffeeScript](coffeescript/AGENTS.md) |
| `crystal/` | [Crystal](crystal/AGENTS.md) |
| `csharp/` | [C#](csharp/AGENTS.md) |
| `dart/` | [Dart](dart/AGENTS.md) |
| `dlang/` | [D](dlang/AGENTS.md) |
| `elixir/` | [Elixir](elixir/AGENTS.md) — `heex/` facts are in this file |
| `fortran/` | [Fortran](fortran/AGENTS.md) |
| `fsharp/` | [F#](fsharp/AGENTS.md) |
| `go/` | [Go](go/AGENTS.md) |
| `graphql/` | [GraphQL](graphql/AGENTS.md) |
| `groovy/` | [Groovy](groovy/AGENTS.md) |
| `haskell/` | [Haskell](haskell/AGENTS.md) |
| `haxe/` | [Haxe](haxe/AGENTS.md) |
| `html/` | [HTML](html/AGENTS.md) |
| `java-kotlin/` | [Java and Kotlin](java-kotlin/AGENTS.md) |
| `javascript/` | [JavaScript / TypeScript, Vue, Svelte](javascript/AGENTS.md) |
| `jsp/` | [JSP](jsp/AGENTS.md) |
| `julia/` | [Julia](julia/AGENTS.md) |
| `lisp/` | [Racket, Scheme, Common Lisp](lisp/AGENTS.md) — `clojure/` has no file |
| `lua/` | [Lua](lua/AGENTS.md) |
| `mojo/` | [Mojo](mojo/AGENTS.md) |
| `nim/` | [Nim](nim/AGENTS.md) |
| `objc/` | [Objective-C](objc/AGENTS.md) |
| `ocaml/` | [OCaml](ocaml/AGENTS.md) |
| `openapi/` | [OpenAPI and AsyncAPI](openapi/AGENTS.md) — `jsight/` and `wsdl/` have no file |
| `pascal/` | [Pascal / Delphi](pascal/AGENTS.md) |
| `perl/` | [Perl](perl/AGENTS.md) |
| `php/` | [PHP](php/AGENTS.md) |
| `powershell/` | [PowerShell](powershell/AGENTS.md) |
| `prisma/` | [Prisma](prisma/AGENTS.md) |
| `protobuf/` | [Protocol Buffers](protobuf/AGENTS.md) |
| `python/` | [Python](python/AGENTS.md) |
| `r/` | [R](r/AGENTS.md) |
| `raku/` | [Raku](raku/AGENTS.md) |
| `ruby/` | [Ruby](ruby/AGENTS.md) — `erb/` facts are in this file |
| `rust/` | [Rust](rust/AGENTS.md) |
| `scala/` | [Scala](scala/AGENTS.md) |
| `serverless/` | [Serverless descriptors](serverless/AGENTS.md) |
| `sfmarkup/` | [Aura and Visualforce](sfmarkup/AGENTS.md) |
| `shared/` | [Regex framework and shared plugin helpers](shared/AGENTS.md) |
| `springxml/` | [Spring XML, MyBatis](springxml/AGENTS.md) |
| `sql/` | [SQL](sql/AGENTS.md) |
| `stylesheet/` | [SCSS, Sass, Less](stylesheet/AGENTS.md) |
| `swift/` | [Swift](swift/AGENTS.md) — `storyboard/` and `coredata/` facts are in this file |
| `templates/` | [Template engines](templates/AGENTS.md) |
| `terraform/` | [Terraform](terraform/AGENTS.md) |
| `thrift/` | [Apache Thrift](thrift/AGENTS.md) |
| `vb/` | [VB.NET, VB6, VBScript](vb/AGENTS.md) |
| `vlang/` | [V](vlang/AGENTS.md) |
| `xaml/` | [XAML](xaml/AGENTS.md) |
| `zig/` | [Zig](zig/AGENTS.md) |

## Languages by front end

- **Tree-sitter** — TS/JS, Vue, Svelte, Python (+ Jupyter `.ipynb`: the Python plugin's `preprocess` joins a Python kernel's code cells, magics blanked, outputs and markdown dropped, facts at the joined text's lines — `PreprocessOutcome.codeOnly` judges line count and minification on that text; a notebook is a dead-code entry), Java/Kotlin, C#, PHP, Pascal/Delphi and the other tree-sitter languages (see each language file). Per-language plugins implement domain extractors + an `ast` hooks bundle.
- **Regex** — each language defines a `RegexLangSpec` in its plugin folder; [regex-extractor.ts](../../core/regex-extractor.ts) dispatches. Go, Rust, C, C++, Lua and Perl-like languages have an optional ANTLR reader (`meta.antlr`), and Swift, Dart, Elixir, Scala, Objective-C and Haskell an optional tree-sitter reader (`meta.treeSitter`) while `parsing` stays `"regex"`; a language with both uses ANTLR's; the per-language files say which.
- A script language sets `topLevelCalls` so the file's own statements become the `<setup>` pseudo-function, as module-level calls do on the tree-sitter path; `deferredBlocks` names the top-level blocks that run later, whose calls the route carries instead.
- A manifest's `sourceDirs` re-admits a directory discovery skips as .NET build output when a marker says it is source, and its `readmitFiles` the files one default ignore skips below such a marker.

## Tree-sitter plugins (AST-based)

Folders: `javascript/`, `python/`, `java-kotlin/`, `csharp/`, `pascal/`, `php/` and the other languages whose manifest says `parsing: "tree-sitter"`.

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

**Registration by scan** — a handler a framework finds by scanning has no call site, so a dispatch resolver gives it an edge from the registering file (per language: [C#](csharp/AGENTS.md), [Java/Kotlin](java-kotlin/AGENTS.md)). Dead-code verdicts are right for such handlers without it (entry base types, `configMentions`); the edge is what removes the "no callers" answer.

## Regex plugins (source text–based)

Folders: `go/`, `rust/`, `ruby/`, `swift/`, `lua/`, `scala/`, `dart/` and the other languages whose manifest says `parsing: "regex"` (PHP is read by tree-sitter).

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

Optional spec hooks used across languages:
- `extractParams` — a declaration's parameters where `extractParamsFromLine` misreads them.
- `extractModuleBindings` — package-level values a later call reads (per language: [Go](go/AGENTS.md), [Dart](dart/AGENTS.md), [Ruby](ruby/AGENTS.md)); `ModuleBindingInfo.lexical` lets the bare name stand for a binding inside its module's body.
- `extractChannelBindings` — a socket's `channel "topic:*", Module` → `FileAnalysis.channelBindings`.
- `extractReExports` — a barrel's `export 'x'`.
- `extractPathArgCalls`, `extractHttpClientRegistrations`, `extractDiBindings`, `extractRequestAccess`, `extractPathReferences`, `extractTestSuites`, `extractConfigKeyReads` — the regex counterparts of the `ast` hooks of the same purpose.
- `attributeLine` turns own-line attributes (`#[serde(rename = "x")]`, `<Required>`, `@Field(key: "x")`) into `decorators` on the function, class or property below them; inline tags (Go `json:"x"`) belong in the property pattern's `build`.
- A route resolver with `afterMounts: true` runs after router mounts and base paths are composed.

## shared/

Details are in [shared/AGENTS.md](shared/AGENTS.md); the files other plugins lean on:

- [shared/regex-base.ts](shared/regex-base.ts) — the `RegexLangSpec` type and the generic `extractFunctionsWithSpec` / `extractClassesWithSpec` / `extractImportsWithSpec` / `extractCallsFromBody` helpers used by all regex plugins; `extractCallsFromBody` runs a call pattern on a line only when the line holds the literals every match of that pattern must contain (`requiredLiterals`: the mandatory top-level characters of its source, none for an alternation, a case-insensitive or an unread pattern) and the baseline `name(` matcher only on a line with `(`, and each pattern's global twin is made once per pattern, not once per body.
- [shared/brace-code.ts](shared/brace-code.ts) — a brace language's literal forms (`BraceLexicon`: comments, strings, raw strings, character literals) and the spec hooks built from them (`braceCodeHooks`): `blockEnds` counts braces over code only, `callSourceLines` blanks raw strings and block comments for the call scan, `commentFreeLines` is what a route scan reads, `startsInCode` keeps a function pattern out of comments and code templates. Go, Rust, C, C++, Scala and Swift use it (Scala with blocks that end by braces or indentation, `scala/blocks.ts`; C and C++ through [shared/c-family-code.ts](shared/c-family-code.ts), which also says when a signature is a definition); [shared/call-chains.ts](shared/call-chains.ts) names a method called on a call's result as the chain (`Club.new().register`).
- [shared/project-info-queries.ts](shared/project-info-queries.ts) — `hasDep` / `hasGoMod` / `hasCsprojPackage` / … predicate helpers over `ProjectInfo` for `frameworks.ts` rules.
- [shared/handler-taint.ts](shared/handler-taint.ts) — request input followed through ONE request handler to a sink (SQL text, command, file path, outbound URL, redirect, eval), the plugin's `ast.taint` hook. The algorithm is here; a plugin supplies a `TaintSpec` (what a handler is, the request-input regex, assignment/call shapes, sanitizers, propagators — the calls whose RESULT carries their arguments' taint; any other function's result is not followed — and sinks with the argument that carries the danger). A language read by ANTLR or regex has no `ast.taint` hook: its meta states `regexTaint` (`{ gate, taint }`) and `file-analyzer.ts` parses a file whose source matches `gate` once more with the tree-sitter grammar the manifest registers (its one variant; the `taint` feature switches it off) and runs the same `handlerTaint` walk — never on a test or generated file or a tree with syntax errors. Per language: [Python](python/AGENTS.md), [JavaScript](javascript/AGENTS.md), [Go](go/AGENTS.md), [Ruby](ruby/AGENTS.md), [Rust](rust/AGENTS.md).
  - Optional spec hooks: `binds` (a call that fills a variable from the request without assigning it), `stringReads`, `valueParts` (data read by one rule in the walk, not a hook: an expression whose value is less than its text — a comparison, an `if`/`match` — and a new language's expression `if`/`when` adds entries), and `condition(ifNode)`, the one text hook for what a guard is looked for in.
  - An `open-redirect` or `ssrf` sink is one a fixed host does not reach (`HOST_CATEGORIES`); a value led by something the request does not control (`base + r.URL.Path`, `"#{root}…"`, `leadingOperand`) keeps its host; a condition that checks a request read (`sourceReads`) clears that read for the rest of the handler; a guard (`startsWith`, `safe…(`, `valid…(` on the value in an `if`) counts as a check. Precision first: every finding is an accusation.
- [shared/security-context.ts](shared/security-context.ts) — `CREDENTIAL_CONTEXT`, the lookahead that keeps an MD5/SHA-1 rule to lines about a credential.

## Framework detection (frameworks.ts)

Manifest-level framework rules live with the plugin that owns the ecosystem — `plugins/<lang>/frameworks.ts` exports `FrameworkRule[]`, wired via `meta.frameworkRules` and aggregated by the registry into `FRAMEWORK_RULES` (duplicate ids throw at registry build). `core/framework-detector.ts` only gathers `ProjectInfo` and runs the rules; it knows no framework names, exactly like `knownPackages`.

- Rule `check` predicates compose the helpers in [shared/project-info-queries.ts](shared/project-info-queries.ts).
- Detections are sorted by id in the detector, so output never depends on plugin registration order.
- Family plugins (javascript, java-kotlin, pascal) attach rules to ONE member meta only (typescript/java/pascal) so the registry sees each rule once.
- Cross-cutting rules live with the plugin that owns the file format: `qt` → cpp, `qt-quick` → qml, `sql` → sql, `jsp` → jsp, `spring-webflow` → springxml, `prisma` → prisma.
- Vendored frameworks with no manifest entry declare `meta.markerCandidates` — well-known relative paths collected into `ProjectInfo.markerFiles` for rules to match on.

## Adding a new language

### Tree-sitter path (preferred when a grammar is available)

1. `npm install tree-sitter-<lang>` (or verify WASM is in a deps package)
2. Add to `Language` type in [../../types/analysis.ts](../../types/analysis.ts)
3. Create `src/extractors/plugins/<lang>/` with per-category extractors
4. Wire each extractor instance onto the meta (`functionsClasses`, `importsExports`, `routes`, `dataSources`, `dataMutations`, `entities`, `dispatchResolvers`, `routeResolvers`)
5. Create `manifest.ts` (the STATIC tier: `language`, `family` — the import-resolution family, shared by languages that resolve each other's bare names (`jvm`, `dotnet`, `cfam`, `script`), else the language's own — `parsing`, extensions (one owner each: the registry throws on a second claim), `grammar` — package + wasm location, with optional per-file variant selection like tsx — test patterns, prefixes/roots, framework hints, `activationFiles`) and `meta.ts` (spreads the manifest, then adds builtins, complexity tables, security rules, ast hooks, and `calls` — at minimum `callNodeTypes`, plus name-resolution/scope hooks as needed; see `call-hooks.ts` in existing plugins). Register the manifest in `ALL_MANIFESTS` (and the meta in `ALL_METAS`) and in `LOADERS` in [../registry.ts](../registry.ts) — extensions, discovery, grammar loading, complexity, call extraction, and the rest flow from there
6. If the ecosystem has detectable frameworks, add `frameworks.ts` (`FrameworkRule[]`) and wire `manifest.frameworkRules` (see "Framework detection" above)

**Grammar viability rule:** the language needs a `web-tree-sitter@0.27`-loadable `.wasm` sitting in its npm package directory. Most packages ship one prebuilt (`tree-sitter-java`, `tree-sitter-c-sharp`); where they don't, [scripts/setup-grammars.mjs](../../../scripts/setup-grammars.mjs) compiles it into `node_modules` with `tree-sitter build --wasm` (Docker/emscripten) — that is how Pascal and Kotlin work, so add the pair there. The `tree-sitter-wasms` bundle is the one dead end: old emscripten dylink format, fails to load ("getDylinkMetadata"). No grammar that compiles cleanly → take the regex path (that is why Dart is regex despite a grammar existing).

### Regex path (languages without a reliable grammar)

1. Add to `Language` type in [../../types/analysis.ts](../../types/analysis.ts)
2. Create `src/extractors/plugins/<lang>/index.ts` exporting a `RegexLangSpec`
3. Create `manifest.ts` (`parsing: "regex"`, `family`, `extensions` — the same list as the spec's) and `meta.ts` (spreads the manifest, `regexSpec: <spec>`, builtins), and register both in [../registry.ts](../registry.ts)
4. A script language whose files run their own statements sets the spec's `topLevelCalls` (`true`, or a path RegExp): calls outside every function/class become the `<setup>` pseudo-function. A top-level block that only REGISTERS code to run later (`get "/x" do … end`, `before_all do`) is listed by `deferredBlocks` so `<setup>` skips its body; the route carries the body's calls itself, and `callSourceLines` blanks those bodies so a named function that registers the route does not count them again; `app.use` mounts and handlers named at the line's end have no body.

### Add an ORM entity extractor

Subclass `EntityExtractor` in `plugins/<lang>/entities.ts`, register it in [src/extractors/entities/index.ts](../entities/index.ts). Emit entity `ClassInfo`s (merged into `analysis.classes` by name) + `EntityRelation`s. For a cross-file join the per-file pass can't do (e.g. Rails attaching `db/schema.rb` columns to models defined in other files), override `reconcileProject(analyses)` — core runs every extractor's pass once via `reconcileProjectEntities` and never names a language itself.

### Container formats (e.g. Vue SFC, Delphi .dfm)

- A format that embeds another language (Vue) declares `preprocess` on the host language's meta — swap in the embedded source/language before parsing, and optionally merge container data back via `postExtract`. `PreprocessOutcome.restoreTypedCalls` asks for noise-named calls to be restored again after a `postExtract` that created their class; `preprocessStamp(absolutePath, projectRoot)` fingerprints what a `preprocess` reads beside the file (its `PreprocessContext`) so `--incremental` notices it.
- A format with its own parser (.dfm) declares `parsing: "custom"` + `customParse`.
- A plugin whose extension is shared with foreign formats refuses those files from `preprocess` with `{ skip }`.
- A parser front end may state each call's arguments (`PatternCallName.args` → `CallInfo.argCount`/`argKinds`/`templateArgs`): `callRecorder` then keeps one row per distinct (name, count, kinds, template arguments) in a function instead of one per name, so `g(1); g(1.0);` are two calls ([C++](cpp/AGENTS.md)).
- An extension several languages share (`.h`) has one owner, but how it is READ can depend on its sub-project: the owner's manifest `readingVariant(relativePath, mix)` gets the project's file counts by extension and names a variant that its `meta.antlr` reader receives as a second argument. The analyzer counts the mix once, passes the variant in `FileTask.reading` (workers never see the mix) and folds it into the file's manifest `resolver` stamp, so a project whose mix flips re-reads its headers although no byte changed. `FileAnalysis.frontEnd.variant` records it. The variants are in [C++](cpp/AGENTS.md).
- Further formats read through a host plugin: Vue template expressions ([JavaScript](javascript/AGENTS.md)), `.dfm` forms ([Pascal](pascal/AGENTS.md)), Jupyter notebooks ([Python](python/AGENTS.md)).

## Conventions

- **One folder per language.** Even tiny regex specs (24 lines) get their own folder for consistency.
- **Line numbers are 1-based** in all output; paths are posix-style.
- **No cross-plugin imports** — if two plugins need the same logic, extract it to `../shared/` or `shared/regex-base.ts`. Extractors communicate only through `FileAnalysis`.
- **Visibility defaults matter.** Java/C# methods default to package-private (isExported=false unless explicitly `public`). Kotlin/TS default to public.
- **Decorators keep their arguments.** `decorators: string[]` holds the attribute/annotation text with its argument list (`Authorize(Policy = nameof(X))`, `ApiVersion("2", Deprecated = true)`), whitespace collapsed — that is where routing, auth and serialization semantics live. Consumers match with a regex or `includes`, never equality on a bare name.
- **Route metadata is language-agnostic.** A route extractor that can see guards, API versions or parameter bindings fills `RouteInfo.middleware` (readable guard strings), `auth`, `versions`/`deprecatedVersions` and `params` — the same fields whatever the framework spells them as — through `shared/route-metadata.ts` (`GuardAttr`, `applyRouteMeta`, `inferredParam`). `csharp/routes/aspnet.ts` and `java-kotlin/routes/meta-annotations.ts` are the references: class-level attributes are inherited by every action, an anonymous marker waives, `[MapToApiVersion]` narrows, and a binding derived from framework defaults is marked `inferred: true`.
- **Handlers declared elsewhere.** Express, Laravel, Rails, Go, Vapor, Phoenix… register a route by naming a handler whose signature the route line never shows. The extractor still sets `handler`; the plugin supplies what the handler READS (`FunctionInfo.requestAccess`, via the regex spec's `extractRequestAccess` or the AST extractor) and, for typed signatures, `meta.requestSchema.bindParam`. `core/request-schemas.ts` (`attachHandlerParams`) resolves the handler by name (same file → same sub-project → project-wide unique) and fills `params` from both. Never look a handler up from a per-file extractor. Name a handler `Class.method` (Play, Grails, Phoenix) when the route names its class: the linker then binds it only to that class's method (a namespaced `MyAppWeb.UserController` counts) and never, by name alone, to a same-named method of another class — an action the class lacks stays unresolved.
- **Request-schema hooks.** A plugin whose language has typed request models exposes `meta.requestSchema` (`unwrapNullable`, `describeType`, `serializedName`, `isSerialized`, `isRequired`, see `csharp/request-schema.ts`). The core pass in `core/request-schemas.ts` does the class lookup, inheritance flattening and recursion; the hooks only say what one type text means and what one property is called on the wire.
- **Reachability (dead code).** `meta.reachability` opts a language into dead-code judgement: `load()` reads the toolchain config once and returns the model core walks (entries by manifest and by convention, specifier → files, path references, template tags). Gate framework directory conventions (`pages/`) on the framework id so a plain SPA's dead page is still found, keep every other doubt on the "reached" side, and leave the hook unset for languages that find files by namespace/autoload. `rust/reachability.ts` (module tree; `mod:`/`path:` references via the regex spec's `extractPathReferences`) and `python/reachability.ts` (`__main__`, `module:`/`file:` references) follow the same shape. `pathReferences` is plugin-private dialect: only the plugin's own model reads it. Split conventions into `entryReason` (where the program starts — anchors a project) and `passiveReason` (run by a tool or instantiated by a framework — configs, migrations, scripts, `[ApiController]`s, `@Component`s): a project anchored only by a migration or a DbContext would have every other file reported. Most languages need no bespoke model: `<lang>/reachability.ts` is a `conventionReachability({...})` spec (shared/reachability-kit.ts) — extensions, `importPath`, which names a file declares, entry files / `main` / `@main`-style source patterns, framework attributes and base types (passive), config files whose identifiers name entries, and an `extend` hook for load-time rules (a Go module path, a gem's `lib/` as public API).
- **Dependency injection: report facts, never resolve.** Core (`core/symbol-linker.ts`) decides which implementation an injected receiver reaches; a plugin supplies the declared types (as written), injection-point `qualifier`s, constructor params, `localTypes` (typed locals and container lookups), `CallInfo.receiverType` for a lookup chained into a call (`calls.receiverTypeOf` / regex `callPatterns` `buildName → receiverType`), `kind: "interface"` (+ `structural`), `abstract` on an abstract class and on each bodyless abstract method (core dispatches through them as through interfaces), every implemented interface as its own `implements` entry, and container registrations as `diBindings` (`ast.diBindings` / `RegexLangSpec.extractDiBindings`). A `@Profile` naming a constant (`PROD`, `Profiles.PROD`, inside a list or a concatenation) is a `${…}` hole in `conditional.profiles`, which core's `resolveBindingConditions` (module-values pass) fills; a list with a name nothing states keeps the bare `Profile` condition. Emit every registration the source states, conditional ones included — core refuses to choose between disagreeing ones. Store the array `extractCalls` returns as-is (append in place): it carries the noise-named calls (`repo.find`) the per-file pipeline restores for typed receivers.
- **Doc comments.** `manifest.docComments` (a `DocCommentSpec` — line prefixes, block delimiters, `docstring`, the attribute lines that may sit between, `blockLead` for a block opened by a lead such as Elixir `@doc """`, `pod` for Perl `=head`…`=cut`, `moduleDocInside` for a module doc read from inside its body, `caseInsensitive` for batch `REM`) is all a language supplies — on the manifest, since MCP tools read it with no plugin body loaded; `core/doc-comments.ts` reads the first sentence above each function, method and class (or the docstring opening its body) into `doc`. Shared shapes: `extractors/shared/doc-comment-specs.ts`.
- **Config reads.** A plugin whose code reads configuration keys marks the row `DataSourceInfo.configRead` (`kind: "env"`, `target` the key as written, no default — Java `@Value`/`@ConfigurationProperties` in [java-kotlin/data-sources.ts](java-kotlin/data-sources.ts), and a Terraform `variable` block as `FileAnalysis.configKeyReads` through the spec's `extractConfigKeyReads` — never a data source) and lists the files that set keys in `serviceConfig.sources` (Terraform's [tfvars.ts](terraform/tfvars.ts), `keysOnly`, names only); core joins them (`core/config-keys.ts`). Never resolve a key to a file in the plugin.
- **File path reads.** `meta.ast.filePathReads(tree, text)` → `FileAnalysis.filePathReads`: literal path parts only (Java/Kotlin `File`/`Paths.get`/`Path.of` in a file importing `java.io`/`java.nio.file`, Python `open`/`Path`/`os.path.join`, JS/TS `fs.readFileSync` & co. on `fs`, `path.join`/`resolve` in a file using `fs`); a hole, a variable or another receiver states nothing. Core resolves them (`core/config-files.ts`).
- **A column on api-call rows.** `DataSourceInfo.column` (0-based UTF-16 code units from the line's start — a JS string index, never a byte count) is stated by every plugin that makes an api-call row, from the node's `startPosition.column` (tree-sitter) or the match index within the line (regex tiers), and by the core passes that build rows from other facts (`client-proxies.ts` and `grpc-clients.ts` carry the source `CallInfo.column` when it has one; `config-patterns.ts` computes it from the match index). A row whose position is unknown stays column-less, never 0: a reader that cuts text before matching states a column only when the line's text before it is unchanged. The element-request rows (`shared/element-requests.ts`) take it from `InteractiveElementInfo.column`.
- **A reader never compares nodes by object identity and never looks a node up in a second `children` call.** A web-tree-sitter wrapper (and a flat node) is a new object per call, so `part !== sig` or `namedChildren(x).indexOf(id)` on a second call never holds; take the list once and use its index, or compare `id`/`startIndex`.
- **A whitespace run is read once** — a pattern that starts an attempt at every position of a long run and lets each attempt read the run to its end is quadratic: one line with 160,000 spaces cost 24 s and the worker deadline then dropped the file. Anchor a whole-text multiline gate to horizontal whitespace (`^[^\S\r\n\u2028\u2029]*`, never `^\s*`, which reads every blank line of a run to its end and finds the same match from the line that holds the word), make a leading `\s*` followed by an optional part atomic (`\s*(?!\s)`) or guard it (`(?:(?<!\s)\s+)?`), put a cheap forward test (`(?=&?[A-Za-z_])`) before a lookbehind that scans back over a run, and look for a `#` or `*` by index before judging its left side (`stripHashComment` in [shared/text-scan.ts](shared/text-scan.ts)). `core/quadratic-whitespace.test.ts` times 18 languages on a 100,000-space line and 50,000 blank lines (each under 1 s) and holds the linear readings equal to the patterns they replace.

## Local types, bindings and receivers

A plugin states facts; core types receivers and links calls.

- **Bindings a body states without a declaration.** A loop variable, a lambda parameter, a narrowed name (`instanceof X x`, `is X`, `if let`, a type switch, `isinstance`), a caught exception or an element read (`list.get(0)`, `m[k]`) is reported as a `localTypes` entry whose `from` names what it is drawn from, or as `CallInfo.receiverType` on the call; core resolves it as it resolves any initializer. JVM and .NET share the chain reader in `shared/element-chain.ts`; tuple unpacking from an annotated return uses `localTypes[].fromIndex` with the manifest's `tupleElementsOf`. Two element types for one name leave it untyped. A `from` may be a chain of calls (Go `club.Address().City()`, Swift `garage.car().engine()`; `Type.init(…)` is a construction of `Type`); a destructured member read off a value or a method's result is `localTypes[].member` with `from` = `club.staff().coach`, written only where the body calls on the name. An element type the source does not state leaves the variable untyped.
  - Loops over a call chain or a typed collection (per language: [Go](go/AGENTS.md), [PHP](php/AGENTS.md), [C++](cpp/AGENTS.md) `cpp/collection-element.ts`, [Rust](rust/AGENTS.md) `rust/collection-element.ts`, [Kotlin](java-kotlin/AGENTS.md) `ChainRules.keys`/`ElementState.key`, [Python](python/AGENTS.md) `rowShape`); a C++ `auto [a, b] = pairOf()` is `fromIndex` entries typed by the manifest's `tupleElementsOf` (`std::pair`/`std::tuple` returns; a struct return stays untyped).
  - A type test narrows PER CALL, never the name: `CallInfo.receiverType` is set only on calls inside the region the test guards ([javascript/narrowing.ts](javascript/narrowing.ts), [csharp/type-tests.ts](csharp/type-tests.ts), Python `match` class patterns, Kotlin `when` arms), and a call outside it, a callback body or after the name is reassigned gets none. The linker keeps ONE link per caller and call name, so a second arm calling the same method name adds none. The regex call recorder likewise keeps a stated `receiverType` in its dedupe key unless the name spells that exact type.
- **Tuple patterns.** Go multi-value returns (`c, err := repo.Find(1)`) type the first result by the declared results; Kotlin, C# and Swift use `fromIndex` locals and a manifest `tupleElementsOf` — Kotlin `val (club, player) = load()` over `Pair`/`Triple` (`java-kotlin/wrapper-elements.ts`) and, with `bindsStructFields`, over a data class's constructor properties in order. A discard or nested pattern only takes up a position.
- **Alias of a typed local (`LocalType.aliasOf`).** A name assigned from another plain name — `const q = p`, Go `q := p` / `&p`, PHP `$q = $p`, C++ `auto& q = p` / `= *p`, Rust `let q = p` / `&p`, Python `q = p` and `(q := p)` — is a `localTypes` entry with `type: ""` and `aliasOf: "p"` (no `from`); core types it through `scopedName(aliasOf, depth + 1)` under the same `MAX_INITIALIZER_DEPTH` cap as initializer calls. The plugin emits it only when the name is bound ONCE, from ONE head, and never reassigned, rebound by a loop/`catch`/`foreach`/destructuring or shadowing a parameter (each plugin checks its own language's forms); everything else stays untyped, so an alias of an untyped name links nothing and a namesake method on another class is never reached. Never an alias: `undefined`, `true`/`false`, `nil`/`nullptr`, `self`/`this`. `aliasOf` is for a head typed by a call (`p = make(); q = p`). Python and PHP read the same order (see their files); Rust and the C family share [plugins/shared/alias-flow.ts](shared/alias-flow.ts): open braces, a binding per name, a loop or closure around the alias leaves it untyped when its head is bound more than once; a binding in a block that closed before the alias, or an untyped one, leaves it untyped. Core's receiver chains follow four calls (`MAX_RECEIVER_CHAIN`).
- **A local bound to a module.** `mod = load_backend()` (the function returns an imported module, `FunctionInfo.returnsModule`) or `importlib.import_module("x")` with a literal (`localTypes[].module`) links `mod.save()` to that module's own function (`moduleLocalCall`), never a namesake ([Python](python/AGENTS.md)).
- **A name the nearest binder rebinds keeps no stale type.** A documented formal (PHP `@param`, Ruby YARD/Sorbet `@param`) holds only while the body does not assign the name again; then the local's own initializer type applies, or nothing. The same holds for a Python module variable a function assigns through `global`, a Dart untyped closure parameter, a Go block-local `type` and the parameter of a JS `this.x = function (p) {…}`.
- **Type-parameter bounds type the parameters written as them.** Java `<U extends Boat>` / `class Garage<T extends Car>`, Kotlin `fun <U : Boat>` / `class G<T : Car>` (also `where U : Boat`) and C# `M<U>(U u) where U : Boat` / class-level `where T : Car` give each parameter and typed local written as that bare letter the bound as its `ParamInfo.type` / `localTypes[].type` ([java-kotlin/type-bounds.ts](java-kotlin/type-bounds.ts), [csharp/type-bounds.ts](csharp/type-bounds.ts)), so `u.sail()` links like any typed receiver — core is untouched. A method's own letter beats an enclosing class's of the same name, innermost class first; an unbounded letter shadows an outer bound and stays untyped. With several bounds the FIRST is taken (`T extends Car & Comparable<T>` → `Car`; Kotlin `where` order; C# `where T : class, Boat` skips `class`/`struct`/`new()`/`notnull`/`unmanaged` and takes `Boat`) — the plugin cannot tell a project class from a library interface, so a project class listed after a library bound is missed. A bound written `where T : Boat` types the letter; a bound that is itself another letter of the member (`where T : U`) leaves the letter untyped; the Kotlin extension receiver (`fun <T : Boat> T.dock()`) takes the bound; fields and constructor properties written as the letter, and a local class or lambda inside a generic method, are not covered. The letter-to-bound substitution is [shared/type-parameter-bounds.ts](shared/type-parameter-bounds.ts).
- **Transparent wrappers.** Only a wrapper a member call passes straight through is listed in `transparentTypeWrappers`: Swift's `Optional` (`Optional<Club>` is `Club?` written long, so `club?.save()` reaches `Club.save`), as Rust's `Arc`/`Box`, Python's `Annotated` and C++'s smart pointers. A wrapper whose members are its own — Java `Optional`/`Provider`, Kotlin `Lazy` (`Lazy.value`), C# `Lazy<T>`/`IOptions<T>`, reached through `.get()`/`.value`/`.Value` — is not listed: `opt.get()` would link to a `get` of the wrapped class.
- **The `valueOut` hook** ([extractors/shared/value-out.ts](../shared/value-out.ts) builds it from a plugin's wrapper calls and members, element calls, element rule and index member) is the one question "what does this hop take out of a declared type":
  - A wrapper call (Java/Kotlin `join`, `get`, `orElseThrow`, `block`, `await`) lets a receiver chain go on from the type argument of a wrapper the call before it declares (`repo.findAsync(id).join().promote()` → `Club`), never through a project class's own `get()`.
  - The hook also fires when the head or a middle segment of the chain DECLARES the wrapper (`private Provider<ClubRepo> provider; provider.get().save()`), and its `members` table names the members that hold the value — Kotlin `.value` on a `Lazy<T>`, C# `.Value` on a `Lazy<T>` / `IOptions<T>` / `IOptionsSnapshot<T>` (`IOptionsMonitor.CurrentValue`), read by `unwrappedDeclared`/`wrappedHead` in `core/symbol-linker.ts` from the written type. `wrapperShadowed` stays per hop kind: the hook returns the head it read and core refuses a project class of that name. The wrapper must be listed under that member, so `Box<ClubRepo>.value` and a project class with its own `get()`/`Value` unwrap nothing.
  - A local holding the unwrapped value: a Java/Kotlin `var c = repo.find(1); c.get().save()` reads the wrapper off the declared return of the one call the local is initialized from (not awaited, no `choice`); a C# `var s = _options.Value; s.Reload()` and a Kotlin `val s = lazy.value` state `localTypes[].from = "_options.Value"` with `member: true`, as does EVERY plain member read off names (never a call, indexer or `?.` in the path) — the plugin never consults the hook's `members` table: the linker takes the value out of a listed wrapper there and else types the local by the member's declared type, untyped where that is no project class.
  - Elements: the hook's `elementCalls` (Java/Kotlin `get`, whose `index` member makes `x[i].m()` an index step read as `x.get(i).m()`: a `List`'s element, a `Map`'s value — `repo.all().get(0).promote()`) and an index read — an `index` segment of the receiver chain (`receiverChainOf`; Kotlin `all()[1]`), a project class's own `get(int)` keeping its declared return. A loop over a typed map's `entrySet()` / Kotlin `entries` types `getValue()`/`getKey()` through the shared element chain.
  - An operator lambda's first parameter (`repo.findAll().map(club -> club.promote())`, a method reference in that place) takes the element of the wrapper the call before it declares, through `collectionElementOf` (Java/Kotlin `Mono`, `Flux`, `CompletableFuture`, `CompletionStage`, `Optional`, `Stream`, Kotlin `Deferred`/`Flow`); `map`/`flatMap` results are typed where the lambda body is one call whose declared return states them (an `@element()` hop in the `from` chain), and a name several lambdas bind is scoped per lambda (`CallInfo.receiverFrom`, falling back to the method-wide type).
  - Where `await` is absent, `asyncResultTypes` unwraps the result type (`Task`, `Future`, `Promise`; per language file).
- **Declared facts a manifest opts into.** `collectionElementOf(type)` reads the element of a declared collection (`Club[]`, `list[Club]`, `[]*Club`, `[Club]`) for a loop or callback local the plugin reports as `localTypes[{ from, element: true }]`; `nestedTypeSeparator` (`.` or `::`, default `::`) and `nestedTypesScopeBare` name nested types by path; `constructorCalls` (`init`, `new`) are sends that construct their receiver class; `bareMembersHideFunctions` makes a class's member win a bare call inside the class over a same-named free function; `importsDeclaredPackages` resolves a dotted import by the package a file declares (`ast.packageName`) before its directory; `compilationDatabase` names the compile database files at a project root (`-I` order and `-D` macros reach `read(source, macros)`); `PackageManifestSpec.projectReferences` returns the sibling projects a build file declares (`SubProject.references`; a reference may name a package — `ProjectReference.package`, npm `workspace:` — resolved to the one sub-project of that ecosystem declaring it); `regexControlFlow.sourceView` gives the control-flow scanner the compiler's view of a body; `ImportInfo.inScope.except` names what an import keeps out of scope; `calls.isApiCallShape(callName, imports)` marks a call shape that is an api-call whatever its receiver; `calls.withSubjectsOf` names the implicit receivers a bare call may run on (Delphi `with`, Kotlin `with`/`apply`).
- **MQTT topics.** `DataSourceInfo.topicSyntax: "mqtt"` joins a publish to the `+`/`#` filters that cover it. A topic argument that is a constant of the file (declared once) reads as its value — a template keeps its `${…}` holes and fills ones the file's constants name (`league/${DIVISION}/score`); a name a project module exports or a `Class.member` of this file (`ClubTopics.TOPIC` beside `LeagueTopics.TOPIC`) is a row with `target: null` + `targetRef`, which core's module-value pass fills from the declaring class so two same-named fields stay apart; a lowercase variable or parameter names no topic. A list or map of topics gives one row per topic.

## Value flow

To let core follow a function value (`const h = save; run(h)`, `this.onSave = save`, `handlers.push(f)`, `return cb`), emit `ValueFlowFact`s on the function that contains the statement (`FunctionInfo.valueFlow`; module-level code in `FileAnalysis.moduleValueFlow`) and nothing more.

- The cell names are as written (`{ name: "this", member: "onSave" }`, a list element as member `"[]"`, a collection field's elements `<field>[]`, a literal key as that key); a `seed` names its function as written (`save`, `this.save`, `Club::save`, a held pseudo-name); the `call` of an `arg`/`result`/`invoke` is `CallInfo.name` with its line, with the written argument index.
- Every seed and copy a held lambda states carries the same `lambda` id (its `line:col`): state every name its body calls — core counts the project functions they resolve to and drops the group above four, so a library's name never uses up the cap.
- An `invoke` fact keeps the call out of the name tiers when its cell is a parameter or the facts write it, so emit it only for a call that runs a held value, never for a method call the ordinary linker resolves; a struct's or interface's own field names are no locals. It is stated only for a name the file proves holds a function (a function-typed parameter or field, a closure or tear-off initializer, a local from a call) — never for a callable object or a name whose type nothing says is a function.
- A name typed by a plain identifier the file cannot judge (a typedef or typealias another file declares) states its `invoke` with `ifFnType`, and the file lists its own function-type aliases in `functionTypeAliases` (`ParsedStructure.functionTypeAliases`); core keeps the invoke (through the host's `isFunctionType` question) only when the linker's function-type question reads that name, as seen from the file (own declarations, imports, own sub-project, imported packages), as such an alias and no class. C/C++ also state it for a `copy` of a parameter stored into a field ([C](c/AGENTS.md), [C++](cpp/AGENTS.md)).
- A keyword or named argument (`callback: f`) is an `arg` with `name` (index -1); core binds the formal whose `ParamInfo.argumentLabel ?? name` is that name — `argumentLabel` states an external label (Swift) or `"_"` for a positional formal (Ruby), so only a keyword formal takes a keyword argument; an unknown name binds nothing. A closure written as an argument stands for the project functions its body calls, as a held one does. C# keeps its arg loop but a named argument is an `arg` with `name`, never mapped by position.
- Both pruning and resolution stay out of plugins: [shared/value-flow-live.ts](shared/value-flow-live.ts) drops facts no invoke, argument or return can reach; resolution, receiver typing and imports stay in core ([../../core/value-flow.ts](../../core/value-flow.ts)).
- Per language: [JavaScript](javascript/AGENTS.md), [Python](python/AGENTS.md), [Java/Kotlin](java-kotlin/AGENTS.md), [C#](csharp/AGENTS.md), [Go](go/AGENTS.md), [Rust](rust/AGENTS.md), [C](c/AGENTS.md), [C++](cpp/AGENTS.md), [PHP](php/AGENTS.md), [Ruby](ruby/AGENTS.md), [Dart](dart/AGENTS.md), [Swift](swift/AGENTS.md).

## Linking rules

- **Extension ownership.** An extension has exactly ONE owning plugin — the registry throws on a second claim. A plugin whose extension is shared with foreign formats refuses those files from `preprocess` with `{ skip }`.
- **Families.** Each manifest declares its `family` (`jvm`, `dotnet`, `cfam`, `script`, …): bare-name import resolution only trusts candidates in the importer's family.
- **Shared scope.** A language whose imports put the imported file's functions in scope without naming them sets `importsShareScope`: the linker then resolves a bare call its own file does not define to the ONE imported file that does (`import-file`). Per language: [PowerShell](powershell/AGENTS.md), [Bash](bash/AGENTS.md), [PHP](php/AGENTS.md), [C](c/AGENTS.md)/[C++](cpp/AGENTS.md) (`declarationExtensions`).
- **Bare calls.** Inside a method, a bare call is the caller's own class's member, then its bases' — never another class's of the same file, and never a class member from a free function (C++ keeps such a link as an INFERRED guess, `bareCallsHideReceivers`); where functions nest, the innermost declaration in scope wins. A call on a capitalized head the project declares as a class (`ClubStore.find(…)`) is a call into that class, whatever its leaf name.
- **Receiver chains** are typed hop by hop, each hop its own prefix, up to 64 hops (`MAX_RECEIVER_CHAIN`). A Go local from a generic constructor written with type arguments drops the list when every element is written as a type (`dropTypeArguments`), while `handlers[k]()` stays an index call.
- **Imports bind only what their path names** — a PHP `use` the class of exactly that namespace, a Rust `crate::` path the importing crate's own `src/` (`importConfinement`: the directory an import path is confined to; a namesake outside it is no answer, but a re-export the language's resolver follows stays allowed), a C `<league/club.h>` only the bodies of that header, a TS default import's reference row the default export.
- **Import renames** are one map, `ImportInfo.aliases` (local → exported, `default` for a default import), in every plugin that renames; the import index asks a language's own resolver for the name an aliased import was exported as. An import that puts a module's members in scope by bare name says so in `ImportInfo.inScope`. A default import under another name, `export { default as x } from`, sourceless re-exports, `export * as ns` and a CommonJS barrel's `module.exports = { a, b }` lead to the definition; a module-level alias (`FileAnalysis.nameAliases`) to the function it names.
- **Relative imports.** One written without an extension also tries every extension of the importer's family (`require './x'` → `x.coffee`); one that names a file with its extension (`#include "parser.h"`) resolves to the file of exactly that name — written without `./` (`include 'inc/header.php'`) from the project root, then beside the importer, then by the one file whose path ends with it, extension included (`uniquePathEnding`; never a body file sharing the header's stem), then by the one path suffix that matches.
- **Run scripts.** An import of a script that is RUN rather than loaded carries `executes: true` and shares nothing — Bash/PowerShell/batch invocations, and processes JS/TS, Python and Go start ([plugins/shared/process-spawns.ts](shared/process-spawns.ts)); a non-relative one resolves under the nearest directory, from the importer's up, that holds the path.
- **Table calls.** A table call (`x.put({ TableName })`) on a receiver imported from a project module is read for its table although the file never names the SDK; the request must still state `TableName` ([JavaScript](javascript/AGENTS.md), [Serverless](serverless/AGENTS.md)).
- **Struct literals** (`&T{}`) construct their type through `withStructLiteralCalls` ([Go](go/AGENTS.md), [Rust](rust/AGENTS.md)).
- **Fan-out.** The unique-global fallback counts definitions (a base method and its same-file overrides are one); an interface method fans out to implementations of interfaces extending it too; where a manifest's `structuralMatch.receiverKinds` is set (Go), a pointer-receiver method is in the method set only of a type some file uses by address ([Go](go/AGENTS.md)). A manifest's `multipleInheritance` (Python) makes member lookup follow the C3 order over `extends` + `implements`.
- **Overloads** are chosen by argument kind (`CallInfo.argKinds`, `calls.argKindsOf`/`overloadTypeKey`), arity only when kinds are unknown.
- **Owner paths.** A call through a nested type's owner path (`Right.Builder.build()`) reaches the class nested in that owner, never a namesake nested elsewhere; where a manifest sets `ownerPathTypes` (Java/Kotlin) a type written through its owner keeps its owner path ([Java/Kotlin](java-kotlin/AGENTS.md)).
- **Parsed owners.** A parser may state the class a member is declared in (`ParsedFunctionSpan.owner`), and `adoptParsedMembers` adopts by it even on the class's own line, so a member the class pass cannot read is never a free function a bare call binds.
- **Inline SQL** in every plugin reads every table a statement names through one shared reader (`statementAccesses` in [plugins/shared/sql-string-sources.ts](shared/sql-string-sources.ts)); table, view and column names read Unicode letters, keywords stay ASCII.
- **An api-call named `VERB /path`** carries its method to the route linker.
- **Client bases.** Plugins state `httpClientRegistrations` (and the api-call row names its receiver as `client`) and, where a language has config files, a `serviceConfig`; a config entry names the variables that override it in `ConfigEntry.envNames` (no module state: one process analyzes many projects). Per language: [Python](python/AGENTS.md) (`python/http-clients.ts`), [Go](go/AGENTS.md) (`go/http-clients.ts`), [PHP](php/AGENTS.md) (`php/service-config.ts`), [Ruby](ruby/AGENTS.md) (`ruby/service-config.ts`), [Rust](rust/AGENTS.md) (`rust/service-config.ts`).
- **Calls the syntax hides.** A call through a computed table (`table[k](…)`) and a named argument (the grammar's `argumentsOf` does not read it) need their own facts, per language.
- **Calls the syntax hides (reads).** A read off a call's result (`repo.find(1).total`) is named as a call chain is (`repo.find().total`) and typed by the linker hop by hop ([Ruby](ruby/AGENTS.md), [Scala](scala/AGENTS.md)).
- **Vue prop-callback marks** stay on the function (per-file JSON): the link carries no copy, so a consumer joins a prop-callback link's `sourceFile` + `sourceSymbol` to that function to tell a prop the child runs from a getter from one a handler runs ([JavaScript](javascript/AGENTS.md)).

## Tests, blocking calls and commands

- `blockingCalls` lists the calls that block inside async code, per language ([C#](csharp/AGENTS.md), [Java/Kotlin](java-kotlin/AGENTS.md), [Rust](rust/AGENTS.md), [Dart](dart/AGENTS.md), [Swift](swift/AGENTS.md)), matched by name inside an `isAsync` function; a name a project class may carry is not listed. `blockingOnReceiver` (`{ receiverTypes, members, types }`) lets core's `findBlockingInAsync` flag `receiver.member()` inside an async function when the receiver's declared type matches — a parameter, a local's stated type, a field of the caller's class, or the declared return of the call it was initialized from; an unknown type, a project class named like the type, or a sync method flags nothing. With `readMembers` the plugin states `FunctionInfo.propertyReads` for a property read no call states (C#: `Result`, `csharp/property-reads.ts`).
- `testCommand(tests, ctx)` returns the runner's command for test files and the test functions a change reaches. `TestCommandContext.projectTests` hands a plugin the test commands the project's root files state (`ProjectAnalysis.projectCommands`, kind `test`, with their `source`). A command that needs more than the test names reads a fact a plugin states, never a guess: `FileAnalysis.testSuites` (`RegexLangSpec.extractTestSuites`) or `TestCommandContext.testTargets`. Scala (`sbt "testOnly *ClubSpec"`), Perl (`prove -l t/club.t`; `prove -lr t` for a distribution) and C/C++ (a CMake root that registers tests: `ctest --test-dir build`, read by the shared `shared/cmake-commands.ts`; `-R '^(Suite\.Case|…)$'` only when it uses `gtest_discover_tests`/`catch_discover_tests` and every name has that shape — a filter matching nothing runs nothing and still passes) state test commands too.

## Shared helpers

- Shared helpers before a plugin's own: `extractors/shared/route-paths.ts` (`joinRoutePath`, `joinRootedPath`, `joinTrimmedPath`) and `extractors/shared/split-top-level.ts` (`splitTopLevel` with options) replace the plugins' separate spellings; a plugin states the spelling it needs as options in a one-line wrapper, and a new spelling goes into their differential tests first. A wrapper is named for its spelling (`splitBracketedArgs`, `splitGoArgs`), never `splitTopLevel`; `extractors/shared/http-verbs.ts` declares the seven verbs once.
- `cli/scripts/check-plugin-helpers.mjs` (run by a vitest) fails when one helper body is declared in two plugin folders, with the bodies left on purpose in `cli/scripts/plugin-helpers-allow.json` (floor 80 normalized characters, a one-line `return shared(…)` wrapper exempt, the allow-list empty; `MIN_BODY=<n>` for a one-off look).
- `plugins/shared/member-names.ts` holds `dropDottedQualifier` and `publicProperty`, and `splitTopLevel`'s `anyOf` splits on several one-character separators; a text holding none of the separators comes back as one piece without the character walk (never with `stopAtCloser`).
- An offset → line counter, a comment blanker (`blankStringAwareComments` when strings must survive), a bracket matcher (`matchingBracket`), a line-end finder, a nested-function filter and a middleware → guard rule are declared once (`plugins/shared/text-scan.ts`, `function-postprocess.ts`, `extractors/shared/route-metadata.ts`), never as an inline `slice(0, i).split("\n")` or a local copy; a helper that is one framework's own spelling stays in its plugin with a comment saying how it differs.
