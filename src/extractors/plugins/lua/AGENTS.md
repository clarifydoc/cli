# Lua plugin

Reads Lua with a regex `RegexLangSpec`; the ANTLR reader (`meta.antlr`, `antlr.ts`, grammar under `cli/grammars/antlr/`, base class `LuaLexerBase.ts`) supplies functions and calls and is on by default. A file with syntax errors keeps the regex reading (`FileAnalysis.frontEnd`); `--feature no-antlr` switches it off.

## Reading

- The spec's `indentBased` flag is listed as true for Ruby and Lua (the shared walk finds block ends by indentation).
- Tables are classes: `PreprocessOutcome.restoreTypedCalls` restores noise-named calls after a `postExtract` that created the table's class (`tables.ts`).
- Control flow: Lua is a keyword-delimited language, read through the regex scanner with the plugin's `blockDelta` hook (what each line opens) and `blockClose` (`end`), `approximate` on the graph (`control-flow.ts`).
- Dead code: a declarative reachability spec of the shared kit.
