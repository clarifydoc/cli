# Lua plugin

Reads Lua with a regex `RegexLangSpec`; the ANTLR reader (`meta.antlr`, `antlr.ts`, grammar under `cli/grammars/antlr/`, base class `LuaLexerBase.ts`) supplies functions and calls and is on by default. A file with syntax errors keeps the regex reading (`FileAnalysis.frontEnd`); `--feature no-antlr` switches it off.

- [index.ts](index.ts) — the spec (`indentBased`: block ends by indentation, as for Ruby); [tables.ts](tables.ts) — tables are classes: `PreprocessOutcome.restoreTypedCalls` restores noise-named calls after a `postExtract` that created the table's class.
- [control-flow.ts](control-flow.ts) — keyword-delimited, read through the regex scanner with the plugin's `blockDelta` (what each line opens) and `blockClose` (`end`), `approximate` on the graph. Dead code: a declarative reachability spec of the shared kit.
