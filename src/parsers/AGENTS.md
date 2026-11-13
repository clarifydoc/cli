# src/parsers — Tree-sitter runtime + specialized parsers

## parser-manager.ts

Wraps `web-tree-sitter` WASM runtime. Key functions:
- `parseSource(sourceText, language, filePath?)` — parse source into a `Tree`
- `runQuery(tree, language, querySource)` — run S-expression queries
- `getParser(language)` / `getLanguage(language)` — lower-level access
- `getGrammarParser(key)` — a parser for a grammar registered by key, for a regex language's tree-sitter front end
  (`meta.treeSitter`): Swift's manifest registers `tree-sitter-swift` while the language stays on the regex path

Grammars are lazy-loaded from npm packages via `GRAMMAR_PACKAGES`. Parsers, languages, and compiled queries are all cached.
A built package reads each grammar's wasm from `dist/grammars/` first: the build copies every variant a plugin
manifest declares there (`scripts/copy-grammars.mjs`), so the grammar packages are devDependencies and installing
`clarifydoc` compiles nothing. Running from `src/` (the tests) finds none there and reads node_modules.

A grammar whose largest WebAssembly function body is over 150 KB (`BASELINE_ONLY_BODY_BYTES` — the lexer of Swift,
Julia, Bash) is compiled to stay on V8's baseline tier (`compileBaselineOnly`): V8's optimizing compiler held 3.5 GB
to tier the Swift lexer up, and did so within the first line of the first file. The load sets
`--no-wasm-lazy-compilation` and `--wasm-tier-up-filter` for one synchronous `new WebAssembly.Module` and puts them
back; the runtime and the other grammars tier up as before. `parser-manager-tiering.test.ts` holds the peak under 500 MB.

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

Delphi form file parser (`.dfm`). Not tree-sitter — uses a custom recursive-descent parser for Delphi's form object notation. Produces `ScreenInfo` with nested `ScreenComponentInfo` tree. A caption is a Pascal string literal decoded (`'caf'#233' squad'` → `café squad`, `''` → `'`). A
component's `dataBindings` add what it shows or runs to its data links: `Action=`, `DataField=` / `FieldName=` and
the DevExpress `DataBinding.` spellings (screen bindings only, never data sources). `origin` is a place stated without
a size (an auto-sized control, or a non-visual component's place on the design surface); `constraints` are what the
form holds a field to (`MinValue`/`MaxValue`, `MaxLength`, `ReadOnly`, `Required`, `Enabled = False`, formats and
masks, on the control or its `Properties.`); an event set on a sub-object (`Properties.OnValidate`) is among the
component's `events`, never an interactive element.

`normalize-source.ts` is the text every front end parses (BOM dropped, `\r\n`/`\r` as `\n`), so its lines are the
ones `splitLines` counts.

## antlr/ — ANTLR4 parsers for regex languages

antlr4ng parsers that read the functions and calls of regex languages (Go, Lua, Rust, C, C++), on by default through the `antlr`
feature (`core/feature-flags.ts`; `--feature no-antlr` switches them off). Generated from
`grammars/antlr/<lang>/*.g4` by `node scripts/generate-antlr.mjs` and committed. Hand-written beside them: each
grammar's base class ported from the `antlr4` runtime (`GoParserBase.ts`, `LuaLexerBase.ts`, …) and `run.ts`
(`parseWithAntlr`: error counting, SLL first and full LL only when SLL fails; with `firstError` the LL pass gives up at its first error too, for a reader that discards a file with any — full-context error recovery is where a parse spends seconds — and past a budget of 2,500 tokens of full-context lookahead plus one per 5 characters — counted, never timed, so a reading cannot depend on the machine's load — so an ambiguity no fix has reached costs a regex reading, not seconds). A file its generator signed (`isGeneratedSource`) or longer than `FRONT_END_MAX_CHARS` (2 M characters, `core/file-analyzer.ts` — a parse holds every token and the tree at once: ~350 MB of heap per MB of generated C tables, ~200 MB per MB of authored C) is never parsed, by any front end: the patterns read it and `frontEnd.fallback` says `generated` or `too-large`. The tree walk that turns a parse into
functions and calls is language knowledge, so it lives in the plugin (`plugins/go/antlr.ts`) and is reached through
`meta.antlr`. A base class must not import the parser that extends it (read token types from the lexer), or the
bundle can evaluate the subclass first. A semantic predicate must read tokens only: the prediction DFA is shared by
every parse in the process, so a predicate reading per-file state the parse fills (grammars-v4 Go's import table, C's
symbol table) makes a file's parse depend on the file before it. State fixed before the parse is fine: C's predicates
read per-token facts its first pass computes (`c/CTypes.ts` — the names used as types, macro names, the `)` closing
each `(`), so no prediction scans forward or reads a token's text, which antlr4ng rebuilds from the character stream
on every read (`c/CKeywords.ts` holds keyword sets by token type, found by lexing each keyword: a rule with several
spellings has no literal name). Nor may a predicate read tokens before the decision (`lt(-1)`): C++'s
`IsInitStatement` did, and a DFA state one file built carried its choice into another's `if` condition — such a
decision is settled from tokens instead (Go's `make(`/`new(` argument lists likewise: the reader's lexer retypes the `(` after such a callee, `GoReadLexer`). Check a change for this by reading a corpus forward and in reverse in two
processes and comparing every file's reading. That independence is also what lets `parseWithAntlr` empty a grammar's cache between parses once it holds more than
10,000 DFA states (`boundPredictionCache`): every state keeps the ATN configuration set it was built from, the cache only grows,
and a worker reading a thousand varied C files held 450 MB of it.

A predicate at an alternative's left edge costs more than its own evaluation: every DFA state of a decision whose
start reaches one carries semantic contexts, and antlr4ng's SLL conflict check copies the whole configuration set
without them for each new state — on C++ that was most of a cold parse. Where the first pass can decide outright, it
retypes the tokens instead (`cpp/CppTypes.ts`: `TemplateLess`/`TemplateGreater`, `CastLeftParen`, `MacroName`, token
types the lexer grammar declares and never matches) and the grammar reads them syntactically. The widest decisions
(C++'s statement, declaration and member) are settled from tokens before prediction runs (`CPP14ParserBase.prepare`
wraps `adaptivePredict`; the alternatives are found by the sub-rule each reaches in the ATN, never by number).
A lexer predicate is worse still: it turns off the lexer's DFA, and a predicate re-reading text from each token's
start makes lexing quadratic (C++ raw strings took minutes on a large file). What only a predicate could lex is
rewritten by the reader before lexing instead, lines and columns kept (`plugins/cpp/antlr.ts` blanks raw strings).
Profile a cold parse by wrapping `adaptivePredict` per decision: a warm one hides it. Profile a slow grammar with `parser.setProfile(true)` and `getParseInfo()` — the decision
with the longest lookahead (`sllMaxLookEvent` gives its text) is the one to restructure. `grammars/antlr/README.md`
records upstream commits and every local change.

## Conventions

- All grammars load lazily — no eager init
- WASM runtime is initialized once per process via `ensureInit()`
- Parse failures should throw so the caller (`analyzer.ts`) can fall back to the regex path
- Language-specific AST node type names vary across grammar versions; when adding a new language, check the grammar's `grammar.js` or parse a sample file to see actual node types
