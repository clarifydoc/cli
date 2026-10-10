# src/extractors/plugins/shared — Regex extraction framework

Shared logic for regex-path language plugins (Go, Rust, Ruby, PHP, Swift, Lua, Scala). Tree-sitter plugins do NOT use this — they use `../../shared/` instead.

## regex-base.ts

Defines the declarative `RegexLangSpec` contract and the generic extraction engine.

### RegexLangSpec

```ts
interface RegexLangSpec {
  language: Language;
  functionPatterns: FnPattern[];       // regex + isExported/isAsync predicates
  classPatterns: ClsPattern[];         // regex + extends extractor
  importPatterns: ImpPattern[];        // regex + source/specifier extractors
  indentBased?: boolean;               // Ruby/Lua use indent; brace languages don't
  lineCommentPrefixes: string[];       // ["//"], ["#"], ["--"]
  topLevelCalls?: boolean | RegExp;    // scripts: top-level statements → `<setup>` (VB: `.vbs` only)
  callPatterns?: CallPattern[];        // extra call shapes; `notAfter` skips continuation lines
  extractRoutes?: (lines, classes) => RouteInfo[];
}
```

A language whose call forms the patterns state completely sets `replacesBaseline` on one of them, and the baseline `name(` matcher is skipped (PowerShell: `Write-Output (Get-Date)` is no call of `Output`).

A `CallPattern` anchored at a statement's start (VB's parenthesis-less `ProcessOrders conn`) sets `notAfter` — a regex the previous line (strings blanked, comment dropped) matches when it carries the statement on — so a continuation line (`b Then` under `If a AndAlso`) is never read as a call.

### Generic extractors

These consume a `RegexLangSpec` and produce standard output:

- `extractFunctionsWithSpec(lines, spec)` — top-level functions
- `extractClassesWithSpec(lines, spec)` — classes + methods + properties (runs function patterns on class body lines)
- `extractImportsWithSpec(lines, spec)` — imports, one `importPatterns` match per line; a spec whose imports are structural sets `extractImports` instead (Go: only inside `import` declarations, aliases kept as the specifier — a per-line `"…"` pattern took every string line for an import and missed `alias "path"`)
- `deriveExportsFromFnClasses(fns, classes)` — all public functions + classes become exports
- `repository-access.ts` `attributeRepositoryAccesses(analyses, knobs)` — the repository pattern over a generic base (`IMovieRepository : IBasicRepository<Movie>`, `RepositoryRecipes(Generic[Recipe, RecipeModel])`): walks the typed member chain across files and puts the generic's entity-typed argument on every CRUD-shaped call; a plugin's entity extractor calls it from `reconcileProject` with its spelling knobs (C#, Python)
- `inflection.ts` `singularize`/`pluralize` — the loose English inflection ORM conventions share (Crystal, Dart)
- `declared-package.ts` `tomlSectionValue(text, sections, key)` — a manifest's own `[package]`/`[project]` name

### Helpers

- `findEndLine(lines, startIdx, indentBased)` — brace-depth or indent-depth end detection
- `extractParamsFromLine(line)` — parses `(a, b: Type, $c)` — handles PHP `$var`, type-first, name-first
- `extractCallsFromBody(lines, startLine, endLine, commentPrefixes)` — regex-based call detection including:
  - `obj.method(` and `$this->obj->method(` (PHP chains)
  - `ClassName.method(` / `ClassName::method(` (static)
  - `self.service.method(` (Python/Ruby)
  - Plain `fn(`

Calls get `kind: "internal"` by default — classification happens later in the core pipeline via `classifyCalls()`.

### CALL_NOISE

Shared set of method names to skip (`len`, `print`, `append`, `map`, `filter`, etc.). Per-language plugins don't need their own noise lists.

## Adding logic here vs in a plugin

- **Shared framework logic** (applies to all regex languages) → here
- **Language-specific quirks** (Ruby `private` keyword handling, PHP `$this->` chains, Go directory imports) → in the plugin or `extractRoutes`

If a pattern is used by multiple plugins but not all, it probably belongs here with a flag on `RegexLangSpec` to opt in.

## Conventions

- **Line-by-line processing** — all pattern matching operates on one line at a time
- **Indent-based languages** need `indentBased: true` and correct indentation — ragged inputs will produce bad end-line estimates
- **Params/properties are best-effort** — the regex won't handle every corner case (default values with commas, generic brackets with commas). That's OK; tree-sitter is the accurate path when available.
