# src/extractors/shared — Cross-language utilities

Utilities used by multiple language plugins. If something is only used by one language, it goes in that plugin folder. Language-specific extractors are wired through each meta's `ast` hooks, not here.

## Files

| File | Purpose |
|------|---------|
| [call-graph.ts](call-graph.ts) | `extractCalls`, `extractTopLevelCalls`, `classifyCalls`, `extractVariableAliases` — the generic call walker and the post-extraction classification (`classifyCalls(calls, imports, language, variableAliases?)`; plugins compose `genericResolveCallName(node, { calleeOverride?, extraCallee? })`; `isDatabaseCall(…, byMethodName = false)` keeps a `this.`/`self.` receiver off `database`); everything language-specific comes from each plugin's `meta.calls` (`CallExtractionHooks`), pushed in by the registry. The hook order and the classification order are documented on the functions |
| [call-patterns.ts](call-patterns.ts) | `isApiCall`, `isDatabaseCall` — the pattern matchers `classifyCalls` uses (per-language roots come from plugin metas) |
| [link-scoring.ts](link-scoring.ts) | `buildLinkGraph(analyses)` (file → file edges with proximity 1–3), `resolveTarget(importSource, sourceFile, filePathMap)`, `buildFilePathMap` — import source → file path |
| [node-helpers.ts](node-helpers.ts) | tree-sitter AST helpers (`getVisibility`, `getNameFromNode`, `getCallName`, `stripQuotes`, `literalString`, `enclosingFunctionNode`, `paramNames`) and the per-grammar decorator extractors |
| [builtin-types.ts](builtin-types.ts) | `isBuiltinType`, `COMMON_PRIMITIVES` (per-language sets pushed in by the registry) |
| [type-parser.ts](type-parser.ts), [type-ref-helpers.ts](type-ref-helpers.ts) | declared-type parsing; `emitParsed`, `findChildByType`, `lineOf` for the `type-references.ts` walkers |
| [destructuring.ts](destructuring.ts) | a destructuring parameter named by its pattern: the props it takes, the names it binds |
| [own-value.ts](own-value.ts) | `ownValue` — every lookup in a fact map (`fieldValues`, `moduleValues`, `stringConstants`) goes through it, never `map?.[key]` (a key the source chose may be `constructor`) |
| [workspace-packages.ts](workspace-packages.ts) | an import of a package the repository itself holds, rewritten to the project path before call classification (JavaScript rules: [JavaScript](../plugins/javascript/AGENTS.md)) |
| [tsconfig-aliases.ts](tsconfig-aliases.ts), [bundler-aliases.ts](bundler-aliases.ts) | import aliases (tsconfig `paths`, bundler `resolve.alias`, framework-generated aliases) rewritten into imports before call classification |
| [router-mounts.ts](router-mounts.ts) | the project-level mount-prefix pass (see [../AGENTS.md](../AGENTS.md)) |
| [route-paths.ts](route-paths.ts), [split-top-level.ts](split-top-level.ts), [http-verbs.ts](http-verbs.ts), [route-metadata.ts](route-metadata.ts) | the shared route-path joins, top-level splitter, the seven verbs, middleware → guard rule |
| [value-out.ts](value-out.ts), [collection-element.ts](collection-element.ts), [awaited-type.ts](awaited-type.ts), [value-resolver.ts](value-resolver.ts) | what a hop takes out of a declared type; constant/value resolution |
| [spec-document.ts](spec-document.ts), [hcl.ts](hcl.ts), [source-lines.ts](source-lines.ts), [dir-listings.ts](dir-listings.ts), [known-code-extensions.ts](known-code-extensions.ts), [module-name-spans.ts](module-name-spans.ts), [message-brokers.ts](message-brokers.ts), [doc-comment-specs.ts](doc-comment-specs.ts), [complexity-defaults.ts](complexity-defaults.ts), [control-flow-defaults.ts](control-flow-defaults.ts), [confidence.ts](confidence.ts) | small leaf tables and readers, each with a header comment |

## Rules

- **No IO** except where a file says so (the alias and workspace readers read config files, through the shared directory listings); the rest are pure AST/string helpers.
- **Language-agnostic at the type level** — take `Language` as a parameter and dispatch through the registry-pushed hook tables. Read hook tables per language, never as a union over plugins (grammars share node names).
- These leaf modules must NOT import the registry (plugin code imports them and the registry imports the metas: a static import back closes an ESM cycle).
- **Noise filtering** is centralized in `call-graph.ts` `NOISE_CALLS`, not per plugin.
- **Adding a language to `CALL_TYPES`** — also verify `NESTED_SCOPE_TYPES` covers its function/class/lambda nodes.
- **Route-path joins and top-level splits**: a plugin states the spelling it needs as options in a one-line wrapper named for that spelling (`splitBracketedArgs`, `splitGoArgs`, never `splitTopLevel`); both helpers have differential tests against the bodies they replaced — add the new spelling there before adding a variant to a plugin. `scripts/check-plugin-helpers.mjs` (run by `plugins/shared/plugin-helpers.test.ts`) fails on one helper body of 80+ normalized characters declared in two plugin folders; a one-line `return shared(…);` wrapper is exempt and a body left on purpose is named in `scripts/plugin-helpers-allow.json` with its reason (empty today). Kept apart from `splitTopLevel` with a comment: `destructuring` (an unterminated string or missing close is `null`) and `plugins/shared/code-lines` `splitArgs` (aligned offsets into two texts).
- Prefer field-based access (`node.childForFieldName("name")`) over positional children — more robust across grammar versions.
