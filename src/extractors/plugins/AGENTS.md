# src/extractors/plugins — Per-language implementations

Each language gets one folder. Two patterns are used depending on whether the language has a working tree-sitter grammar:

## Tree-sitter plugins (AST-based)

Folders: `javascript/`, `python/`, `java-kotlin/`, `csharp/`, `pascal/`

Contents (varies slightly per language):
```
<lang>/
├── meta.ts                   LanguagePluginMeta — tables, hooks, extensions (registered in ../registry.ts)
├── frameworks.ts             FrameworkRule[] — manifest-level framework detection for the ecosystem (optional)
├── functions-classes.ts      extends FunctionClassExtractor
├── imports-exports.ts        extends ImportExportExtractor
├── data-sources.ts           extends DataSourceExtractor (optional)
├── data-mutations.ts         extends DataMutationExtractor (optional)
└── routes/                   framework-specific route extractors (optional)
```

Each extractor class implements `abstract collectFunctions(node, results)` / `collectClasses` / `collectImports` / etc. using tree-sitter AST walking. The class is registered in the corresponding `src/extractors/<category>/index.ts`.

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

[shared/project-info-queries.ts](shared/project-info-queries.ts) — `hasDep` / `hasGoMod` / `hasCsprojPackage` / … predicate helpers over `ProjectInfo` for `frameworks.ts` rules.

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
4. Register each extractor in `src/extractors/<category>/index.ts`
5. Create `meta.ts` (`parsing: "tree-sitter"`, extensions, `grammar` — package + wasm location, with optional per-file variant selection like tsx — builtins, complexity tables, security rules, framework hints, ast hooks, and `calls` — at minimum `callNodeTypes`, plus name-resolution/scope hooks as needed; see `call-hooks.ts` in existing plugins) and add it to `ALL_METAS` in [../registry.ts](../registry.ts) — extensions, discovery, grammar loading, complexity, call extraction, and the rest flow from there
6. If the ecosystem has detectable frameworks, add `frameworks.ts` (`FrameworkRule[]`) and wire `meta.frameworkRules` (see "Framework detection" above)

### Regex path (languages without reliable grammar)

1. Add to `Language` type in [../../types/analysis.ts](../../types/analysis.ts)
2. Create `src/extractors/plugins/<lang>/index.ts` exporting a `RegexLangSpec`
3. Create `meta.ts` (`parsing: "regex"`, `extensions: <spec>.extensions`, `regexSpec: <spec>`, builtins) and add it to `ALL_METAS` in [../registry.ts](../registry.ts)

### Container formats (e.g. Vue SFC, Delphi .dfm)

- A format that embeds another language (Vue) declares `preprocess` on the host
  language's meta — swap in the embedded source/language before parsing, and
  optionally merge container data back via `postExtract`.
- A format with its own parser (.dfm) declares `parsing: "custom"` + `customParse`.

## Conventions

- **One folder per language.** Even tiny regex specs (24 lines) get their own folder for consistency.
- **Visibility defaults matter.** Java/C# methods default to package-private (isExported=false unless explicitly `public`). Kotlin/TS default to public.
- **Line numbers are 1-based** in all output.
- **No cross-plugin imports** — if two plugins need the same logic, extract it to `../shared/` or `shared/regex-base.ts`.
