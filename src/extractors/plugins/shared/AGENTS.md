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
  extractRoutes?: (lines, classes) => RouteInfo[];
}
```

### Generic extractors

These consume a `RegexLangSpec` and produce standard output:

- `extractFunctionsWithSpec(lines, spec)` — top-level functions
- `extractClassesWithSpec(lines, spec)` — classes + methods + properties (runs function patterns on class body lines)
- `extractImportsWithSpec(lines, spec)` — imports
- `deriveExportsFromFnClasses(fns, classes)` — all public functions + classes become exports

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
