# src/parsers — Tree-sitter runtime, flat trees, ANTLR readers

Per-language specifics (Vue/Svelte/Astro component splitting, Delphi `.dfm`, each ANTLR reading's tree walk) live in the plugin folders' `AGENTS.md` under [../extractors/plugins/](../extractors/plugins/AGENTS.md): [javascript](../extractors/plugins/javascript/AGENTS.md) (`vue-sfc.ts`), [pascal](../extractors/plugins/pascal/AGENTS.md) (`dfm-parser.ts`). This file holds what is common to all front ends.

## parser-manager.ts

Wraps the `web-tree-sitter` WASM runtime.

- `parseSource(sourceText, language, filePath?)` — parse source into a `Tree`
- `runQuery(tree, language, querySource)` — run S-expression queries
- `getParser(language)` / `getLanguage(language)` — lower-level access
- `getGrammarParser(key)` — a parser for a grammar registered by key, for a regex language's tree-sitter front end (`meta.treeSitter`): the language stays on the regex path (`parsing: "regex"`) while its manifest registers a grammar (Swift's registers `tree-sitter-swift`)

`TreeSitterLanguage` is `Language` minus the languages with no tree-sitter parse: `dfm`, `swift`, `lua`, `scala`, `go`, `rust`, `ruby`, `perl`, `vb`, `sql`, `c`, `cpp`, `dart`. Everything else, PHP included (`parsing: "tree-sitter"` in its manifest), is parsed by `parseSource`; the excluded ones use the regex path in `src/core/regex-extractor.ts`, optionally with an ANTLR or tree-sitter front end (below).

- Grammars load lazily from npm packages via `GRAMMAR_PACKAGES`; parsers, languages and compiled queries are cached; the WASM runtime is initialized once per process (`ensureInit()`).
- A built package reads each grammar's wasm from `dist/grammars/` first: the build copies every variant a plugin manifest declares there (`scripts/copy-grammars.mjs`), so grammar packages are devDependencies and installing `clarifydoc` compiles nothing. Running from `src/` (the tests) finds none there and reads `node_modules`.
- A grammar whose largest WebAssembly function body is over 150 KB (`BASELINE_ONLY_BODY_BYTES` — the lexer of Swift, Julia, Bash) is compiled to stay on V8's baseline tier (`compileBaselineOnly`): the optimizing compiler held 3.5 GB to tier the Swift lexer up. The load sets `--no-wasm-lazy-compilation` and `--wasm-tier-up-filter` for one synchronous `new WebAssembly.Module` and puts them back. `parser-manager-tiering.test.ts` holds the peak under 500 MB.
- Parse failures throw, so the caller (`analyzer.ts`) can fall back to the regex path.
- Node type names vary across grammar versions: check the grammar's `grammar.js` or parse a sample before writing an extractor.

### Adding a tree-sitter grammar

```ts
// In GRAMMAR_PACKAGES:
myLang: { pkg: "tree-sitter-mylang", wasm: "tree-sitter-mylang.wasm" },

// If the npm package has no main entry (common for prebuilt WASM packages):
myLang: { pkg: "tree-sitter-mylang", wasm: "tree-sitter-mylang.wasm", viaPkgJson: true },
```

Also add the `TreeSitterParseable` union member and the extension mapping in [language-map.ts](language-map.ts).

## flat-tree.ts

The only tree path (no feature flag; a leftover `no-flat-tree` in `CLARIFYDOC_FEATURES` is ignored). `parseSource` of a language in `FLAT_TREE_LANGUAGES` (C#, Java, JavaScript, Kotlin, PHP, Python and TypeScript — TSX and the script parts of Vue/Svelte components are TypeScript text — plus F#, Bash, R, Julia, Zig, OCaml and Pascal's `.pas`) copies the tree with one cursor walk into typed arrays (`flattenTree`), frees the WebAssembly tree and returns a `FlatTree`.

- `FlatNode`s answer the used subset of `Node` from those arrays: fixed fields, child lists built on first use into the tree's tables. The `type` patch and pinned root are for real trees only.
- `flat-tree.test.ts` compares every member to the real tree on all fixtures, including web-tree-sitter's quirks: `descendantsOfType` includes the node itself, `nextSibling` passes over an empty MISSING sibling, `childForFieldName` of an ERROR node is null. `descendantForIndex` is not copied (its edge answers differ by grammar), so callers descend through `children`.
- `parseErrorsOf` and `runQuery` know a flat tree. A hidden zero-width MISSING token an external scanner inserts is never visited by the cursor, so `flattenTree` asks the real nodes for `hasError` when the real root has it and the copy does not (`readErrorFlags`).
- A language joins the set only when its corpus output is byte-identical on the flat copy and the real tree (`--stable-output`).
- The regex languages' tree-sitter front ends (`treeSitterReader`) and the Go, Rust and Ruby taint readers (`regexTaintOf`) parse through `getGrammarParser` and read a flat copy through `readableTree` (the `FLAT_GRAMMAR_KEYS` grammar keys).
- A reader must never compare nodes by object identity or look one up in a second `children` call: a real node is a fresh wrapper per call, a `FlatNode` is not, so such a line reads differently on the two trees.

## language-map.ts

Single source of truth for extension → `Language` mapping. Keep in sync with `EXTENSION_MAP` in [../core/file-discovery.ts](../core/file-discovery.ts).

## Component and form parsers

`vue-sfc.ts` (returns `{ script, scriptLang, template, templateComponents }`), `svelte-sfc.ts` and `astro-sfc.ts` split a single-file component into script and template parts, `template-tree.ts` builds the template tree, and `dfm-parser.ts` / `dfm-binary.ts` read Delphi form files without tree-sitter. Their output shapes and rules are in the JavaScript and Pascal plugin files.

`normalize-source.ts` is the text every front end parses (BOM dropped, `\r\n`/`\r` as `\n`), so its lines are the ones `splitLines` counts.

## antlr/ — ANTLR4 readers for regex languages

antlr4ng parsers that read the functions and calls of Go, Lua, Rust, C and C++, on by default through the `antlr` feature (`core/feature-flags.ts`; `--feature no-antlr` / `CLARIFYDOC_FEATURES=no-antlr` switches back to the regex path, which stays; `node cli/scripts/ab-features.mjs <project>` compares the two). A plugin's `meta.antlr` reader supplies the file's functions and calls; every other `RegexLangSpec` extractor still reads the lines, and a file with syntax errors keeps the regex reading (`FileAnalysis.frontEnd`).

- Grammars are generated from [cli/grammars/antlr/](../../grammars/antlr/README.md) `<lang>/*.g4` by `node scripts/generate-antlr.mjs` and committed; the README records upstream commits and every local change.
- Hand-written beside them: each grammar's base class ported from the `antlr4` runtime (`GoParserBase.ts`, `LuaLexerBase.ts`, …) and `run.ts`.
- The tree walk that turns a parse into functions and calls is language knowledge: it lives in the plugin (`plugins/<lang>/antlr.ts`) and is reached through `meta.antlr`.
- A base class must not import the parser that extends it (read token types from the lexer), or the bundle can evaluate the subclass first.

### run.ts

- `parseWithAntlr`: error counting; SLL first, full LL only when SLL fails. With `firstError` the LL pass gives up at its first error too, for a reader that discards a file with any (full-context error recovery is where a parse spends seconds).
- A budget of 2,500 tokens of full-context lookahead plus one per 5 characters ends a full-context pass — counted, never timed, so a reading cannot depend on the machine's load; an ambiguity no fix has reached costs a regex reading, not seconds.
- A file its generator signed (`isGeneratedSource`) or longer than `FRONT_END_MAX_CHARS` (2 M characters, `core/file-analyzer.ts`; a parse holds every token and the tree at once: ~350 MB of heap per MB of generated C tables, ~200 MB per MB of authored C) is never parsed by any front end: the patterns read it and `frontEnd.fallback` says `generated` or `too-large`.
- `boundPredictionCache`: once a grammar's DFA cache holds more than 10,000 states, it is emptied between parses (every state keeps the ATN configuration set it was built from and the cache only grows; a worker reading a thousand varied C files held 450 MB). That is possible because no parse may depend on the one before it (next section).

### Predicates and decision settling

- A semantic predicate reads tokens only: the prediction DFA is shared by every parse in the process, so a predicate reading per-file state the parse fills (a import table, a symbol table) makes a file's parse depend on the file before it. State fixed before the parse is fine: C's predicates read per-token facts its first pass computes (`c/CTypes.ts` — the names used as types, macro names, the `)` closing each `(`), so no prediction scans forward or reads a token's text, which antlr4ng rebuilds from the character stream on every read (`c/CKeywords.ts` holds keyword sets by token type, found by lexing each keyword).
- A predicate must not read tokens before the decision (`lt(-1)`; C++'s `IsInitStatement` did): a DFA state one file built carries its choice into another's. Such a decision is settled from tokens instead. Check a change by reading a corpus forward and in reverse in two processes and comparing every file's reading.
- A predicate at an alternative's left edge costs more than its own evaluation: every DFA state of a decision whose start reaches one carries semantic contexts, and antlr4ng's SLL conflict check copies the whole configuration set without them for each new state. Where the first pass can decide outright, it retypes tokens instead (token types the lexer grammar declares and never matches) and the grammar reads them syntactically.
- A lexer predicate turns off the lexer's DFA, and one re-reading text from each token's start makes lexing quadratic. What only a predicate could lex is rewritten by the reader before lexing, lines and columns kept.
- A settled decision answers from tokens before prediction runs. It must agree with what prediction picks: found in the ATN by the sub-rule each alternative reaches (never by number), scanned once per grammar, and held equal by parse trees on a corpus and a `*-settle.test.ts`. Read the corpus's fall-backs to the full-context pass too, since a wrong settle there still gives equal trees.
- A grammar fix beats a retype where one exists: an SLL failure on valid code is an ambiguity SLL resolves to its first alternative. Find the decision by logging where the SLL pass fails on files full-context reads cleanly.
- Full-context prediction runs only on a file SLL already failed, and a file the reader refuses pays twice, so the decisions it spent its time on are settled too. To find the next one, log `execATNWithFullContext` per decision (rule, line, tokens consumed) on the refused files. Profile a cold parse by wrapping `adaptivePredict` per decision (a warm one hides it); profile a slow grammar with `parser.setProfile(true)` and `getParseInfo()` — the decision with the longest lookahead (`sllMaxLookEvent` gives its text) is the one to restructure.

### Per grammar

The settled decisions and retypes of each grammar are documented where they live: Go in `go/GoParserBase.ts`
(`GoParserBase.settleStatements`, the operand decisions, `bracedLiteralHere`; `go-settle.test.ts`), Rust in `rust/RustReadLexer.ts`
(`STRUCT_LBRACE`, the SLL pass `parseSll` in `run.ts`) and `rust/RustParserBase.ts` (`settleExpressions`;
`rust-settle.test.ts`), C in `c/CTypes.ts` (the first pass: type names, `hideMacros`) and `c/CParserBase.ts`
(`settleDecisions`; `c-settle.test.ts`), C++ in `cpp/CppTypes.ts` (template-bracket, cast and macro retypes,
`hideTypeMacroArguments`) and `cpp/CPP14ParserBase.ts` (`CPP14ParserBase.prepare`, `settleSpecifierLoop`, `settleTypeSpecifier`;
`cpp-settle.test.ts`). The C macro shapes the first pass sets aside (`hideMacros`) or retypes (the retype block of `facts`), and the
statement and file-scope macro predicates of `CParserBase`, each have a failing-first test with a decoy in
`plugins/c/macro-shapes.test.ts`; a new shape goes there. A settled decision is held equal to prediction by parse trees on a corpus of real files and by
the `*-settle.test.ts` of its grammar; read the corpus's full-context fall-backs too, since a wrong settle there still
gives equal trees.

- C is read in two passes without `gcc -E`: the names a file uses as types, read off its tokens, then the parse, whose
  predicates take them for typedef names. The tree walks and macro-body links are in the plugins:
  [plugins/c/antlr.ts](../extractors/plugins/c/antlr.ts), [plugins/cpp/antlr.ts](../extractors/plugins/cpp/antlr.ts).
- C and C++ share the `#if` handling ([plugins/shared/preprocessor-branches.ts](../extractors/plugins/shared/preprocessor-branches.ts))
  and the token-level call scan ([plugins/shared/token-calls.ts](../extractors/plugins/shared/token-calls.ts)); how
  macro bodies (`MacroInfo.calls`, `macroBodyLinks`, `SymbolLink.viaMacro`) and guarded headers (`withoutCppGuards`) are
  linked is in the [C](../extractors/plugins/c/AGENTS.md) and [C++](../extractors/plugins/cpp/AGENTS.md) files.
  `cli/scripts/reduce-refused-c.mjs` (logic in `scripts/lib/c-reduce.mjs`, tested in `antlr/c-reduce.test.ts`) reduces a refused
  file to its minimal failing form: it settles the `#if` structure first (`first`/`second`/`off` keep one branch of each conditional, `asis`
  keeps every directive), names the unit the reader first refuses, and shrinks the context before it; `c-family-errors.mjs` gives the exact token.
- `GoReadLexer` retypes the `(` after `make`/`new`; `CParserBase.settleDecisions` is settled in the full-context pass over
  a refused file as well; Rust's `RustParserBase.settleExpressions` runs in SLL passes only.

## Tree-sitter front ends for regex languages

The same seam with a tree-sitter grammar: `meta.treeSitter` reads functions and calls from the grammar the manifest's `grammar` registers while `parsing` stays `"regex"`. On by default for Swift, Dart, Elixir, Scala, Objective-C and Haskell; the readers are `plugins/<lang>/tree-sitter.ts`.

- Loading, freeing and error counting are shared in [plugins/shared/tree-sitter-front-end.ts](../extractors/plugins/shared/tree-sitter-front-end.ts); the naming of a callee read as steps is [plugins/shared/callee-names.ts](../extractors/plugins/shared/callee-names.ts) (a call through a path is named by every name back to its head — `nameCall`'s `paths` — so the linker types the receiver from the head; each language's own call patterns are tried on the callee's text first).
- These readers read a flat copy of the tree through `readableTree` ([flat-tree.ts](flat-tree.ts)), byte-identical on a Go, a Dart, an Elixir, a Rust and a Ruby corpus.
- The feature is `tree-sitter` (`no-tree-sitter:swift`, `no-tree-sitter:dart`, `no-tree-sitter:elixir`, `no-tree-sitter:scala`, `no-tree-sitter:objc`, `no-tree-sitter:haskell`). A language with both front ends uses ANTLR's.
- Some grammars are pinned to upstream commits because the npm release is stale or has no loadable wasm; `npm run setup` (and the Dockerfile's grammar stage) builds them, patching the external scanner first ([cli/scripts/grammar-patches.mjs](../../scripts/grammar-patches.mjs): its out-of-memory `fprintf`/`exit` cannot link in Wasm, and an empty `deserialize` kept the previous parse's state). Which and why: [Dart](../extractors/plugins/dart/AGENTS.md), [Scala](../extractors/plugins/scala/AGENTS.md).
- Each language's reader specifics are in its own file: [Swift](../extractors/plugins/swift/AGENTS.md), [Elixir](../extractors/plugins/elixir/AGENTS.md) (HEEx `~H` markup read line by line), [Objective-C](../extractors/plugins/objc/AGENTS.md), [Haskell](../extractors/plugins/haskell/AGENTS.md).
