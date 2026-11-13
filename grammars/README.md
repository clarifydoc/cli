# Grammars — choosing a language's front end

A language is read by one of three front ends. All three produce the same `FileAnalysis`:

| Front end | Where | Used when |
| --- | --- | --- |
| tree-sitter (the plugin's own path) | `src/parsers/parser-manager.ts`, `meta.grammar` | a wasm grammar loads and real code parses with almost no `ERROR` nodes |
| a second front end beside the patterns: ANTLR (`meta.antlr`, [antlr/](antlr/README.md)) or tree-sitter (`meta.treeSitter`) | `src/parsers/antlr/`, `src/extractors/plugins/shared/tree-sitter-front-end.ts` | the patterns stay for every other extractor, and the parser supplies functions and calls; a file with syntax errors keeps the pattern reading (`FileAnalysis.frontEnd`) |
| patterns only (`RegexLangSpec`) | `src/core/regex-extractor.ts` | no grammar is viable |

## Rules

- **Keep the pattern reading.** A parser front end is a feature flag (`src/core/feature-flags.ts`, `--feature no-<name>`)
  with the patterns as the per-file fallback. Never delete the fallback when a parser becomes the default.
- **Measure before you choose.** Before you adopt a grammar, measure the share of real files that parse with errors,
  and the share of bytes in `ERROR` nodes, on several real repositories per language. Small valid snippets prove
  nothing: two grammars that read snippets cleanly left half of real code in `ERROR`. Then compare the readings with
  `node scripts/ab-features.mjs <project>`, and look at every disagreement you sample before you call either side
  right.
- **Readings must not depend on file order.** Read a corpus forward and in reverse, in two processes, and compare
  every file's reading. A shared prediction cache, or a predicate that reads per-file state, breaks this (see
  `src/parsers/AGENTS.md`).
- **Bump `EXTRACTOR_VERSION`** when the default front end changes for a language. Feature flags are part of the
  cache stamp (`extractorStamp()`), so a run with a non-default flag never reuses another run's cache.
- **Pin what npm gets wrong.** Where the npm release is old or ships no loadable wasm, depend on an upstream commit
  and build the wasm in `scripts/setup-grammars.mjs`. Patch the scanner in `scripts/grammar-patches.mjs` when it
  cannot link in Wasm (`fprintf`/`exit`), or keeps state across parses. Record the pin, and the reason for it, on
  this page.

## tree-sitter grammars on npm (checked under web-tree-sitter 0.27)

- **Load:** bash, powershell, groovy, fsharp, julia, ocaml (+ `ocaml_interface`), batch, css, ruby, scala, haskell,
  elixir, objc, `@davisvaughan/tree-sitter-r`, `@tree-sitter-grammars/tree-sitter-zig`,
  `@tree-sitter-grammars/tree-sitter-lua`.
- **Load, but too many `ERROR`s on real code:** groovy and powershell. Both stay pattern-only.
- **Don't load:** `tree-sitter-v`, npm's `tree-sitter-dart` (pinned to an upstream commit instead), and anything from
  the `tree-sitter-wasms` bundle (old emscripten dylink format: "getDylinkMetadata").
- **No wasm shipped:** scss, haxe, d, scheme, commonlisp, cuda, pkl, the unscoped `tree-sitter-zig`, and Swift
  (built from a patched upstream commit).
- **Not on npm:** crystal, nim, racket, fortran, raku, sml, mojo, coffeescript, autoit, ahk, vbscript, less.
- **Never install** `tree-sitter-r`, `tree-sitter-pkl` or `tree-sitter-erlang`. They are npm `0.0.1-security`
  placeholders that replaced removed malware.
- C and C++ tree-sitter grammars failed on 30–56 % of real files (macros, unknown typedefs). C and C++ are read by
  ANTLR with a token-level first pass instead.
