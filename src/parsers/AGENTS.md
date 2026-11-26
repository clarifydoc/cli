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

`flat-tree.ts` (the only path since the `flat-tree` feature, on by default from 1.731.0, was retired; a leftover `no-flat-tree` in `CLARIFYDOC_FEATURES` is ignored): `parseSource` of a language in `FLAT_TREE_LANGUAGES` (C#, Java, JavaScript, Kotlin, PHP, Python and TypeScript — TSX and the script parts of Vue/Svelte components are TypeScript text — plus F#, Bash, R, Julia, Zig, OCaml and Pascal's `.pas`) copies the tree with one cursor walk into typed arrays (`flattenTree`), frees the WebAssembly tree and returns a `FlatTree` whose `FlatNode`s answer the used subset of `Node` from those arrays (fixed fields, child lists built on first use into the tree's tables; the `type` patch and pinned root are for real trees only). `flat-tree.test.ts` compares every member to the real tree on all fixtures, including web-tree-sitter's quirks (`descendantsOfType` includes the node itself, `nextSibling` passes over an empty MISSING sibling, `childForFieldName` of an ERROR node is null). `parseErrorsOf` and `runQuery` know a flat tree. A hidden zero-width MISSING token (Kotlin's automatic semicolon) is not visited by the cursor, so `flattenTree` asks the real nodes for `hasError` when the real root has it and the copy does not. A language joins the set once its corpus output is byte-identical on the flat copy and the real tree. The regex languages' tree-sitter front ends (`treeSitterReader`: Swift, Dart, Elixir, Scala, Objective-C, Haskell) and the Go, Rust and Ruby taint readers (`regexTaintOf`) parse through `getGrammarParser`; they read a flat copy too, through `readableTree` (the `FLAT_GRAMMAR_KEYS` grammar keys). A reader must never compare nodes by object identity or look one up in a second `children` call: a real node is a fresh wrapper per call, a `FlatNode` is not, so such a line reads differently on the two trees (two Dart readers did, and now state what they always computed).

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
decision is settled from tokens instead (Go's `make(`/`new(` argument lists likewise: the reader's lexer retypes the `(` after such a callee, `GoReadLexer`; Go's simple-statement decision — `:=`, `=`, `++`, expression, send — is settled in an SLL pass by `GoParserBase.settleStatements`, which scans to the first deciding token outside brackets and leaves a `{` or `<-` to prediction; it held two thirds of a 3,000-file Go corpus's DFA states, and the full-context pass never uses it; the same hook settles `operand` and `primaryExpr`'s operand-or-conversion choice and `keyedElement`'s key — a token only one alternative starts, a name not followed by `{` (after `pkg.` or a bracketed list too), a `{` after a name by the Go spec's rule that a bare-name literal in an `if`/`for`/`switch` header is a block (`bracedLiteralHere`, read off the context's ancestors), `[]T{` against `[]T(` by the token that ends the type, a key by a `:` outside brackets — each held equal to prediction by parse trees on every file of a 3,000-file Go corpus and by `go-settle.test.ts`; read the corpus's fall-backs to the full-context pass too, since a wrong settle there still gives equal trees). Check a change for this by reading a corpus forward and in reverse in two
processes and comparing every file's reading. That independence is also what lets `parseWithAntlr` empty a grammar's cache between parses once it holds more than
10,000 DFA states (`boundPredictionCache`): every state keeps the ATN configuration set it was built from, the cache only grows,
and a worker reading a thousand varied C files held 450 MB of it.

Rust's SLL pass reads through `RustReadLexer` (`parseSll` in `run.ts`, tried before `parseWithAntlr`): from the tokens before it alone it retypes the `{` of a struct literal as `STRUCT_LBRACE`, which a path followed by `{` cannot be told from an `if`/`match` block without the expression's context — SLL has none, so a file with `Json(Club { id })` failed that pass and was read again in full-context mode, five times slower and, on a real repository, 60% of the parse time. A brace it leaves plain still parses (the grammar takes either token), and when the SLL pass fails the plain lexer's two-stage parse decides, so a wrong guess costs a second reading, never a different tree. `settleExpressions` (called by the Rust plugin's `makeParser`, SLL passes only) answers the `if … else` decision (`else` enters, any other token ends) and the method-call choice in `expression`/`statementExpression`'s operator loop (`. name (` with `precpred` holding) from tokens, finding both in the ATN by shape: prediction read to the end of an else-branch or argument list to tell `x.f(y)` from a called field, and those two were over half of one large repository's prediction states; the scan is cached per ATN, and `rust-settle.test.ts` holds the trees equal. Likewise a grammar fix beats a retype where one exists: an SLL failure on valid code is an ambiguity SLL resolves to its first alternative (closure parameters were `pattern`, so `|b| f(b)` read the body as an alternative of the parameter; `impl A + B` sat after `impl A` inside `typeNoBounds`) — find the decision by logging where the SLL pass fails on files full-context reads cleanly.

A predicate at an alternative's left edge costs more than its own evaluation: every DFA state of a decision whose
start reaches one carries semantic contexts, and antlr4ng's SLL conflict check copies the whole configuration set
without them for each new state — on C++ that was most of a cold parse. Where the first pass can decide outright, it
retypes the tokens instead (`cpp/CppTypes.ts`: `TemplateLess`/`TemplateGreater`, `CastLeftParen`, `MacroName`, token
types the lexer grammar declares and never matches) and the grammar reads them syntactically. The widest decisions
(C++'s statement, declaration and member) are settled from tokens before prediction runs (`CPP14ParserBase.prepare`
wraps `adaptivePredict`; the alternatives are found by the sub-rule each reaches in the ATN, never by number).
A macro no grammar rule reads can leave the default channel instead (`hideTypeMacroArguments`): a call's arguments where only a type or scope goes (`typename BIND_(Sel, T) Name` also drops the `typename`, the macro's name being the type), and a whole suppression macro standing between two member initializers with no comma (`a_(x), WARNINGS_PUSH_(4355) b_(y)`, only inside a constructor's `:` list); a macro whose arguments hold a `return` is a statement macro (`MacroName`).
Full-context prediction only runs on a file SLL already failed (a valid file never reaches it), and every file the reader
refuses pays for it twice (the conditionals as written, then first branches), so the decisions it spent its time on are
settled too: a qualified name's scope (`std::vector<Club>`: the optional scope of a simple type and each turn of its loop),
whether a declaration starts with specifiers, and a definition's `(…)` followed by a body or `;`. A settled decision must
agree with what prediction picks: a lookahead that sees past the predicate decides some cases (`size_t i, j;` is not two
types), so the specifier LOOP settles only what a lookahead cannot overturn: a name the predicate refuses ends the list, a name followed by `*`, `&`, `&&` or another plain name reads on, a keyword that only starts or only ends a list decides (`settleSpecifierLoop`, the sets read off the ATN), a name before `,`/`)`/`;` stays with prediction; `typeSpecifier` takes a trailing type for any token no class or enum starts with and `struct X {` / `struct X*` by the token after the name (`settleTypeSpecifier`); each rule is gated by the corpus' per-file readings, byte-identical.
To find the next one, log `execATNWithFullContext` per decision (rule, line, tokens consumed) on the refused files.
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

## Second front ends for regex languages

- **ANTLR (on by default for Go, Lua, Rust, C and C++)** — a regex plugin's `meta.antlr` reader — an antlr4ng parser generated from [cli/grammars/antlr/](../../grammars/antlr/README.md) (Go, Lua, Rust, C, C++) — supplies the file's functions and calls; every other `RegexLangSpec` extractor still reads the lines, and a file with syntax errors keeps the regex reading (`FileAnalysis.frontEnd`). Rust's SLL pass reads through `RustReadLexer` (`parseSll`): the `{` of a struct literal is retyped `STRUCT_LBRACE` from the tokens before it, a closure parameter is a `patternNoTopAlt` and `impl`/`dyn` bounds come before `typeNoBounds`, so valid files no longer fall through to full-context prediction (about half the Rust parse time; a failed hinted pass falls back to the plain two-stage parse). `RustParserBase.settleExpressions` answers two decisions from tokens in an SLL pass: an `if`'s optional `else` (the `else` token goes on with the `if`) and an expression's `. name (` method call, when the call's precedence predicate holds at that point — prediction read the whole else-branch or argument list to tell a method call from a called field, a third of one large Rust repository's DFA states each; found in the ATN by shape and scanned once per grammar, held equal to prediction by `rust-settle.test.ts`. `--feature no-antlr` / `CLARIFYDOC_FEATURES=no-antlr` ([core/feature-flags.ts](../core/feature-flags.ts)) switches back to the regex path, which stays; `node cli/scripts/ab-features.mjs <project>` compares the two. C is read in two passes without `gcc -E`: the names a file uses as types, read off its tokens ([parsers/antlr/c/CTypes.ts](antlr/c/CTypes.ts)), then the parse, whose predicates take them for typedef names; `#if 0` is left out, a file that does not parse is read again with each conditional's first branch (the other branches' calls read off their tokens, their definitions from a second-branch reading), and unexpanded macros — loops, statement macros, attribute macros — are grammar rules, and a macro that stands where no rule has it is set aside on the hidden channel by the first pass (`hideMacros`, `c/CTypes.ts`: before a cast, in a cast's type, between initializer entries, after an attribute, a call between a `*` and the declared function's name, a name between a type and an attribute that precedes the declared name or between a prototype's parameters and its attribute, one after `[` before a called name, names alone before a struct body's `}` or ending a file) ([plugins/c/antlr.ts](../extractors/plugins/c/antlr.ts); the `#if` handling and the token-level call scan are shared with C++: [plugins/shared/preprocessor-branches.ts](../extractors/plugins/shared/preprocessor-branches.ts), [plugins/shared/token-calls.ts](../extractors/plugins/shared/token-calls.ts)); a call that lands on a function-like `#define` (its own file's, else the one definition its includes reach) also makes the calls the macro's body makes (`MacroInfo.calls`, `macroBodyLinks`): INFERRED links carrying `SymbolLink.viaMacro` (summary and payload slot [10]), nested macros four deep, each `#define` hop keeping its own row; their line is the macro's use, which does not spell the callee, so the rename plan, caret assertions and the resolved-site sets (`isSpelledCallSite`) refuse or skip them, and where a caller's one link to a function has both a macro use and a line that spells the call, both dedupes keep the spelled line. C++ the same way ([plugins/cpp/antlr.ts](../extractors/plugins/cpp/antlr.ts); a header whose C++ is only inside `#ifdef __cplusplus` / `#if defined(__cplusplus)` is offered to the C reader, `withoutCppGuards`; `cli/scripts/reduce-refused-c.mjs` reduces a refused file to its minimal failing form, directives kept), its first pass ([parsers/antlr/cpp/CppTypes.ts](antlr/cpp/CppTypes.ts)) also retyping tokens the grammar then reads syntactically — template brackets, C-style casts' `(`, macros with type arguments — and the statement, declaration and member decisions settled from tokens (`CPP14ParserBase.prepare`), which is what made a cold parse fast enough; full-context prediction runs only on files SLL refused, so its widest decisions — a qualified name's scope, whether a declaration starts with specifiers, a definition's parameter list followed by a body or `;` — are settled from tokens before prediction (fmt −39% CPU; a settled decision must agree with what prediction picks, so the specifier loop settles only a name the predicate refuses, a name before `*`/`&`/`&&`/another plain name and the keywords only one side takes (`size_t i, j;` stays with prediction), and `typeSpecifier` settles a trailing type or a class body by the tokens (tree-equal on 13 repositories, `cpp-settle.test.ts`)); Go's simple-statement decision is settled the same way in an SLL pass (`GoParserBase.settleStatements`, Go `readGo` CPU −55%); C's block item, statement, file-scope macro, specifier-loop and after-label decisions too (`CParserBase.settleDecisions`, `readC` −30 to −37% on two C repositories; settled in the full-context pass over a refused file as well, parse CPU −2 to −25%), and C++ `simpleTypeSpecifier`/`templateArgument` (a path holding `template` stays with prediction) and Rust's `(` call, each held tree-equal by its `*-settle.test.ts`; a macro no rule reads can leave the default channel instead (`hideTypeMacroArguments`): `typedef typename MACRO(…) Name` reads the macro as the type, a suppression macro standing between two member initializers with no comma is hidden, and a macro whose arguments hold a `return` is a statement macro.
- **tree-sitter for a regex language (on by default for Swift, Dart, Elixir, Scala, Objective-C and Haskell)** — the same seam with a tree-sitter grammar: `meta.treeSitter` ([plugins/swift/tree-sitter.ts](../extractors/plugins/swift/tree-sitter.ts), [plugins/dart/tree-sitter.ts](../extractors/plugins/dart/tree-sitter.ts), [plugins/elixir/tree-sitter.ts](../extractors/plugins/elixir/tree-sitter.ts) — HEEx `~H` markup read line by line, since the grammar reads a sigil as text, [plugins/scala/tree-sitter.ts](../extractors/plugins/scala/tree-sitter.ts) — an anonymous instance's methods lend their calls to the function building it, [plugins/objc/tree-sitter.ts](../extractors/plugins/objc/tree-sitter.ts) — message sends on property paths, constructions and other sends — and [plugins/haskell/tree-sitter.ts](../extractors/plugins/haskell/tree-sitter.ts) — applications without parentheses, a signature and its equations one function) reads functions and calls from the grammar the manifest's `grammar` registers while `parsing` stays `"regex"` (parser-manager's `getGrammarParser`; loading, freeing and error counting in [plugins/shared/tree-sitter-front-end.ts](../extractors/plugins/shared/tree-sitter-front-end.ts), the naming of a callee read as steps in [plugins/shared/callee-names.ts](../extractors/plugins/shared/callee-names.ts) — Dart, Swift and Scala name a call through a path by every name back to its head (`club.league.relegate`, `PlayerService.instance.add`; `nameCall`'s `paths`), as the Ruby scan does, so the linker types the receiver from the head, each language's own call patterns tried on the callee's text first). With the `flat-tree` feature these front ends and the Go/Rust/Ruby taint readers read a flat copy of the tree (`readableTree`, [parsers/flat-tree.ts](flat-tree.ts)), byte-identical on a Go, a Dart, an Elixir, a Rust and a Ruby corpus. The feature is `tree-sitter` (`no-tree-sitter:swift`, `no-tree-sitter:dart`, `no-tree-sitter:elixir`, `no-tree-sitter:scala`, `no-tree-sitter:objc`, `no-tree-sitter:haskell`); a language with both front ends uses ANTLR's. Dart's and Scala's grammars are pinned to upstream commits (npm's tree-sitter-dart 1.0.0 is from 2023 and its wasm does not load; npm's tree-sitter-scala 0.24.0 fails on a fifth of Play and Scala 3 files, v0.26.3 on 3 of 3,427). npm has no wasm for it, so `npm run setup` (and the Dockerfile's grammar stage) builds one from upstream's 0.7.4 commit, patching the external scanner first ([cli/scripts/grammar-patches.mjs](../../scripts/grammar-patches.mjs): its out-of-memory `fprintf`/`exit` cannot link in Wasm, and an empty `deserialize` kept the previous parse's state). The grammars-v4 Swift 5 ANTLR grammar was tried first: Swift 5.4 only (no `async`/`await`, `actor`, `any`, macros), ~100 KB/s, and no licence.
