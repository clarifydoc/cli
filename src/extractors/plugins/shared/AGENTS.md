# src/extractors/plugins/shared — Regex extraction framework and helpers several plugins share

Shared logic for regex-path language plugins (the ones whose manifest says `parsing: "regex"`: see [../AGENTS.md](../AGENTS.md)), plus text and node helpers any plugin may use. Tree-sitter plugins use `../../shared/` for the language-agnostic part.

## Where logic goes

- **Framework logic that applies to every regex language** → here; if a pattern serves several plugins but not all, it lives here behind a flag on `RegexLangSpec` that opts in.
- **Language-specific quirks** → in the plugin or its `extractRoutes`.
- A helper two plugins spell the same way lives here once; a plugin never imports another plugin. Before moving a copy here, compare what the body READS as well as its text: two `scanTags` with the same body read different tag regexes, so they are not the same function. A helper that is one framework's own spelling stays in its plugin with a comment saying how it differs.

## The regex framework

- [regex-base.ts](regex-base.ts) — the `RegexLangSpec` contract (`functionPatterns`, `classPatterns`, `importPatterns`, `indentBased`, `blockEnds`, `callSourceLines`, `lineCommentPrefixes`, `topLevelCalls`, `callPatterns`, `extractRoutes`, …; each field's doc comment says what it means — `FnPattern.keywordNames` lets a name spell a keyword) and the generic engine (`extractFunctionsWithSpec`, `extractClassesWithSpec`, `extractImportsWithSpec`, `deriveExportsFromFnClasses(fns, classes)`, `findEndLine(lines, startIdx, indentBased)`, `extractParamsFromLine(line)` for `(a, b: Type, $c)`, `extractCallsFromBody(lines, startLine, endLine, commentPrefixes)`, `CALL_NOISE`, which a call marked `PatternCallName.keepNoise` / `receiver.keepNoise` bypasses). [../../../core/regex-extractor.ts](../../../core/regex-extractor.ts) dispatches to it.
- [brace-code.ts](brace-code.ts) — a brace language's literal forms (`BraceLexicon`) and the spec hooks built from them (`braceCodeHooks`); Go, Rust, C, C++, Scala and Swift use it. [c-family-code.ts](c-family-code.ts), [call-chains.ts](call-chains.ts), [code-lines.ts](code-lines.ts) build on it.
- [sql-string-sources.ts](sql-string-sources.ts) — the ONE reader of SQL text (`statementAccesses`); [sql-heredoc.ts](sql-heredoc.ts) reads heredoc SQL.
- [repository-access.ts](repository-access.ts) — the repository pattern over a generic base (`RepositoryTactics(Generic[Tactic, TacticModel])`, `self.items = repos.items`, `self.repos.clubs.league_table()`), a project pass a plugin's entity extractor calls as `attributeRepositoryAccesses(analyses, knobs)` from `reconcileProject` (C#, Python); a plugin that reads SQL handed to a call emits `joinedTableRows(sql, own, name, line)` for the extra tables.
- [handler-taint.ts](handler-taint.ts) — request input followed through one handler to a sink; the plugin's `ast.taint` hook or a regex language's `regexTaint`. Per language: [Python](../python/AGENTS.md), [JavaScript](../javascript/AGENTS.md), [Go](../go/AGENTS.md), [Ruby](../ruby/AGENTS.md), [Rust](../rust/AGENTS.md).
- C-family front-end helpers, used by the C and C++ readers ([C](../c/AGENTS.md), [C++](../cpp/AGENTS.md), [parsers](../../../parsers/AGENTS.md)): [preprocessor-branches.ts](preprocessor-branches.ts) `readWithBranches`, [token-calls.ts](token-calls.ts) `tokenCalls`/`defineCalls`/`leftOutCalls`, [c-family-macros.ts](c-family-macros.ts) `extractCFamilyMacros`/`macroBodyCalls` (Objective-C reads its own through `extractMacros` on its spec).
- [shebang-scripts.ts](shebang-scripts.ts) — extension-less `#!` scripts for the reachability models' name mentions; discovery admits the same scripts through each manifest's `shebangInterpreter` and shares the bounds.
- [inflection.ts](inflection.ts) (`singularize`/`pluralize`, `camelCase`), [declared-package.ts](declared-package.ts) (`tomlSectionValue(text, sections, key)`), [project-info-queries.ts](project-info-queries.ts) (predicates for `frameworks.ts` rules), [security-context.ts](security-context.ts) (`CREDENTIAL_CONTEXT`).

## Text and node helpers

- [text-scan.ts](text-scan.ts) — plain text: `lineAt`, `lineIndex`/`lineStarts`/`lineOfOffset`, `preparedLines(blank)`, `blankStringAwareComments`, `matchingBracket`, `balancedArgs`, `splitTopLevelCommas`, …. A plugin never declares its own offset → line counter or an inline `slice(0, i).split("\n")`; a loop over matches builds one `lineIndex(text)` before it. A language's comment/string spelling is an option of `blankStringAwareComments`, never a private copy.
- [code-lines.ts](code-lines.ts) — one line of a brace language read as code (`codeOf`, `splitArgs`, `statementsOf`, …); the line-based DI readers (Dart, Scala, Swift) use it.
- [ts-nodes.ts](ts-nodes.ts) — `namedChildren` / `descendants` for the grammar-backed readers of regex languages; [callee-names.ts](callee-names.ts) holds `idStep`.
- [function-postprocess.ts](function-postprocess.ts) — `dropNestedFunctions`, `tidySetupCalls` for the regex script plugins.
- Declared elsewhere: `splitGeneric` in `../../shared/type-parser.ts`, `isAuthGuard` and `middlewareGuardOf(expr, authRe, schemeRe)` in `../../shared/route-metadata.ts`, `unwrapParenthesized` in `../../shared/node-helpers.ts`.

## Conventions

- **Line-by-line processing** — all pattern matching operates on one line at a time.
- **Indent-based languages** need `indentBased: true` and correct indentation — ragged inputs give bad end-line estimates.
- **Params and properties are best-effort** — the regex will not handle every corner (default values with commas, generic brackets with commas); tree-sitter is the accurate path when there is a grammar.
- Calls get `kind: "internal"` by default; classification happens later in `classifyCalls()`.
