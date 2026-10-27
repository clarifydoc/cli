# src/parsers — Tree-sitter runtime + specialized parsers

## parser-manager.ts

Wraps `web-tree-sitter` WASM runtime. Key functions:
- `parseSource(sourceText, language, filePath?)` — parse source into a `Tree`
- `runQuery(tree, language, querySource)` — run S-expression queries
- `getParser(language)` / `getLanguage(language)` — lower-level access

Grammars are lazy-loaded from npm packages via `GRAMMAR_PACKAGES`. Parsers, languages, and compiled queries are all cached.

`TreeSitterLanguage` excludes languages that **don't** have tree-sitter grammars (`dfm`, `swift`, `lua`, `scala`, `go`, `rust`, `ruby`, `php`). Those use the regex path in `src/core/regex-extractor.ts`.

### Adding a new tree-sitter grammar

```ts
// In GRAMMAR_PACKAGES:
myLang: { pkg: "tree-sitter-mylang", wasm: "tree-sitter-mylang.wasm" },

// If the npm package has no main entry (common for prebuilt WASM packages):
myLang: { pkg: "tree-sitter-mylang", wasm: "tree-sitter-mylang.wasm", viaPkgJson: true },
```

Also add:
- `TreeSitterParseable` union type
- Extension mapping in [language-map.ts](language-map.ts)

## language-map.ts

Single source of truth for extension → `Language` mapping. Keep in sync with `EXTENSION_MAP` in [../core/file-discovery.ts](../core/file-discovery.ts).

## vue-sfc.ts

Parses Vue Single File Components — splits into `<script>`, `<template>`, `<style>` blocks. Returns `{ script, scriptLang, template, templateComponents }`. The analyzer parses the script with tree-sitter and extracts template components separately via string matching.

## dfm-parser.ts

Delphi form file parser (`.dfm`). Not tree-sitter — uses a custom recursive-descent parser for Delphi's form object notation. Produces `ScreenInfo` with nested `ScreenComponentInfo` tree.

## antlr/ — ANTLR4 parsers for regex languages

antlr4ng parsers that read the functions and calls of regex languages (Go, Lua), on by default through the `antlr`
feature (`core/feature-flags.ts`; `--feature no-antlr` switches them off). Generated from
`grammars/antlr/<lang>/*.g4` by `node scripts/generate-antlr.mjs` and committed. Hand-written beside them: each
grammar's base class ported from the `antlr4` runtime (`GoParserBase.ts`, `LuaLexerBase.ts`, …) and `run.ts`
(`parseWithAntlr`: error counting, SLL first and full LL only when SLL fails). The tree walk that turns a parse into
functions and calls is language knowledge, so it lives in the plugin (`plugins/go/antlr.ts`) and is reached through
`meta.antlr`. A base class must not import the parser that extends it (read token types from the lexer), or the
bundle can evaluate the subclass first. A semantic predicate must read tokens only: the prediction DFA is shared by
every parse in the process, so a predicate reading per-file state (grammars-v4 Go's import table) makes a file's parse
depend on the file before it. Profile a slow grammar with `parser.setProfile(true)` and `getParseInfo()` — the decision
with the longest lookahead (`sllMaxLookEvent` gives its text) is the one to restructure. `grammars/antlr/README.md`
records upstream commits and every local change.

## Conventions

- All grammars load lazily — no eager init
- WASM runtime is initialized once per process via `ensureInit()`
- Parse failures should throw so the caller (`analyzer.ts`) can fall back to the regex path
- Language-specific AST node type names vary across grammar versions; when adding a new language, check the grammar's `grammar.js` or parse a sample file to see actual node types
