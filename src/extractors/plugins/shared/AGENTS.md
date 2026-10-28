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
  blockEnds?: (lines) => Map<number, number>;  // the language's own block ends (Ruby: by keyword), before the indent/brace guess
  callSourceLines?: (lines) => string[];       // the lines the call scan reads (Ruby: heredocs, %w[], =begin blanked; #{} as code)
  lineCommentPrefixes: string[];       // ["//"], ["#"], ["--"]
  topLevelCalls?: boolean | RegExp;    // scripts: top-level statements → `<setup>` (VB: `.vbs` only)
  callPatterns?: CallPattern[];        // extra call shapes; `notAfter` skips continuation lines
  extractRoutes?: (lines, classes) => RouteInfo[];
}
```

A language whose blocks neither braces nor indentation delimit reliably supplies `blockEnds` (0-based start line → 1-based last line, memoized per `lines` array): Ruby's [ruby/blocks.ts](../ruby/blocks.ts) blanks non-code (heredocs, `%w[]`, `=begin`, `#{}`, regex literals) and closes `def`/`class`/`if`/`do` at their `end`, so a method-level `rescue` stays in its method and a heredoc at column 0 does not end the class. A start it does not list falls back to `findEndLine`. `FnPattern.keywordNames` lets a name spell another language's keyword (`def self.for`).

A language whose call forms the patterns state completely sets `replacesBaseline` on one of them, and the baseline `name(` matcher is skipped (PowerShell: `Write-Output (Get-Date)` is no call of `Output`).

A `CallPattern` anchored at a statement's start (VB's parenthesis-less `ProcessOrders conn`) sets `notAfter` — a regex the previous line (strings blanked, comment dropped) matches when it carries the statement on — so a continuation line (`b Then` under `If a AndAlso`) is never read as a call.

### Generic extractors

These consume a `RegexLangSpec` and produce standard output:

- `extractFunctionsWithSpec(lines, spec)` — top-level functions
- `extractClassesWithSpec(lines, spec)` — classes + methods + properties (runs function patterns on class body lines)
- `extractImportsWithSpec(lines, spec)` — imports, one `importPatterns` match per line; a spec whose imports are structural sets `extractImports` instead (Go: only inside `import` declarations, aliases kept as the specifier — a per-line `"…"` pattern took every string line for an import and missed `alias "path"`)
- `deriveExportsFromFnClasses(fns, classes)` — all public functions + classes become exports
- `repository-access.ts` `attributeRepositoryAccesses(analyses, knobs)` — the repository pattern over a generic base (`IMovieRepository : IBasicRepository<Movie>`, `RepositoryRecipes(Generic[Recipe, RecipeModel])`): walks the typed member chain across files (a member assigned a chain on a typed constructor parameter, `self.items = repos.items`, included) and puts the generic's entity-typed argument on every CRUD-shaped call — a wrapper whose type arguments name no entity (`HttpRepo[ClubCreate, ClubOut]`) takes the entity of the repository it was built with; a plugin's entity extractor calls it from `reconcileProject` with its spelling knobs (C#, Python)
- `inflection.ts` `singularize`/`pluralize` — the loose English inflection ORM conventions share (Crystal, Dart)
- `declared-package.ts` `tomlSectionValue(text, sections, key)` — a manifest's own `[package]`/`[project]` name
- `preprocessor-branches.ts` `readWithBranches(text, cplusplus, read)` — the C-family parser front ends' reading of `#if`: dead blocks (`#if 0`, `__cplusplus` as the language says) blanked; a file that does not parse read again with each conditional's first branch, the left-out branches' calls counted, a second-branch reading's definitions added (C, C++)
- `token-calls.ts` `tokenCalls`/`defineCalls`/`leftOutCalls` — calls read off a C-family ANTLR lexer's tokens (`TokenKinds`) where a parse reads no expression: macro arguments, a `#define` inside a function, left-out branches

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
