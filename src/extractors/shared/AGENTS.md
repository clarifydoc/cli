# src/extractors/shared — Cross-language utilities

Utilities used by multiple language plugins. If something's only used by one language, put it in that plugin folder instead.

## Files

| File | Key exports | Used by |
|------|-------------|---------|
| [call-graph.ts](call-graph.ts) | `extractCalls`, `extractTopLevelCalls`, `classifyCalls`, `extractVariableAliases` | all tree-sitter plugins |
| [call-patterns.ts](call-patterns.ts) | `isApiCall`, `isDatabaseCall` (per-language roots pushed in by the registry from plugin metas) | `classifyCalls`, `plugins/javascript/data-sources` |
| [link-scoring.ts](link-scoring.ts) | `buildLinkGraph`, `resolveTarget`, `buildFilePathMap` | `core/analyzer.ts`, `core/symbol-linker.ts` |
| [node-helpers.ts](node-helpers.ts) | `getVisibility`, `getNameFromNode`, `getCallName`, `stripQuotes`, `literalString` (through `as const`/`satisfies`/parens/`!`), `FUNCTION_NODE`, `enclosingFunctionNode`, `paramNames`, decorator extractors | all tree-sitter plugins |
| [builtin-types.ts](builtin-types.ts) | `isBuiltinType` (per-language sets pushed in by the registry from plugin metas), `COMMON_PRIMITIVES` | `type-parser`, `core/type-reference-extractor.ts` |
| [destructuring.ts](destructuring.ts) | `destructuredProps`, `patternBindings` — a destructuring parameter named by its pattern: the props it takes, the names it binds | `core/file-analyzer` (a call shadowed by a parameter), `plugins/javascript/dispatch` ([JavaScript](../plugins/javascript/AGENTS.md)) |
| [own-value.ts](own-value.ts) | `ownValue` — a fact map (`fieldValues`, `moduleValues`, `stringConstants`) read at a key the analyzed source chose, own properties only: `constructor`, `toString`, `__proto__` answer nothing, never what a plain object inherits. Every such lookup goes through it, never `map?.[key]` | `core/api-targets`, `core/module-values`, the URL and constant readers of the plugins |
| [type-ref-helpers.ts](type-ref-helpers.ts) | `emitParsed`, `findChildByType`, `lineOf` | `plugins/<lang>/type-references.ts` walkers |
| [workspace-packages.ts](workspace-packages.ts) | `loadWorkspacePackages`, `applyWorkspacePackages`, `namesWorkspacePackage`, `workspacePackageDir` — an import of a package the repository itself holds, rewritten to the project path before call classification (rules in the [JavaScript](../plugins/javascript/AGENTS.md) file); a package's own subpath (`league-club/services/roster` inside `league-club`) loads its own file, its own bare name is left to its resolver | `core/file-analyzer` (imports), `core/analyzer` (component graph), `tsconfig-aliases` (`extends`) |

Language-specific extractors live in their plugins and are wired through each meta's `ast` hooks (`plugins/javascript/interactive-elements.ts`, `sub-components.ts`, `events.ts`; `plugins/python/python-tokenizer.ts`; the type-reference walkers `plugins/<lang>/type-references.ts`).

## call-graph.ts — the core of call extraction

The walkers and the classification pipeline are generic; everything language-specific comes from each plugin's `meta.calls` (`CallExtractionHooks`), pushed in by the registry. Read hook tables per language, never as a union over plugins (grammars share node names — `assignment_expression` is JS and Java — and a union made a file's calls depend on what its worker had read before). The hooks, in the order the walk uses them:

1. **`callNodeTypes`** — AST node types that are function calls.
2. **`nestedScopeTypes`** — node types that start a new scope; `extractCalls` stops recursing at one. It also skips a childless node of a type it never reads (`READ_TYPES_BY_LANGUAGE`: nested scopes, call types, binding sites) when the plugin has no `readNames` hook and no `skip`, and either no `collectExtraCalls`/`destructuredFromCall`/`heldFunction` hook or states every node type they act on as `perNodeTypes` (added to the read set) — a new hook that must see every node goes into that condition. `anonymousScopeTypes`: a function expression walked on its parent's behalf unless a declarator names it. `localDeclarationTypes` (Java `local_variable_declaration`, C# `local_declaration_statement`) says a declarator in a local declaration names a value, not a function, so `Runnable r = () -> club.save();` leaves `club.save` on the enclosing method's row (a field's lambda stays out); per-language node names are in the [Java/Kotlin](../plugins/java-kotlin/AGENTS.md) and [C#](../plugins/csharp/AGENTS.md) files.
3. **`resolveCallName`** — full name resolution for the language; plugins compose `genericResolveCallName(node, { calleeOverride?, extraCallee? })`. Whatever the hook returns, a member chain written across lines is named as on one line (`compactCallName`: whitespace holding a line break beside `.`, `?.`, `::` or `->` goes — `club\n    .save()` is `club.save`, as a formatter writes a long chain), so the call and its `localTypes[].from` spelling (`callChainText`) link like the one-line twin.
4. **`collectExtraCalls`** — extra call shapes (JSX component refs, Python decorators).
5. **`heldFunction`** — a function expression the plugin extracts as a function of its own though no declarator names it: a callback handed on to run later. The walk stops there and records the enclosing function handing it on (`passed: "argument"`; module code hands it on from `<setup>`), so reach keeps the writer's calls one `passes` hop further, while whatever joins a later run (an emit, a prop call, a member call) lands on the callback alone. Complexity skips them (`<…@line>`): the writer's metric already counts the body. Ordinary inline arrows stay the writer's. The held-function shapes are in the [JavaScript](../plugins/javascript/AGENTS.md) file.
6. **`classifyAutoImported`** / **`qualifiedRootCandidates`** — classification hooks (Vue macros; Java `userService`→`UserService`, Python snake→Pascal, Pascal `F`-strip); see [Pascal](../plugins/pascal/AGENTS.md).
7. **`callbackArgNodeTypes`** + **`bindingSites`** / **`bindingPatterns`** — an identifier passed as an argument is recorded as a call (`items.map(formatUser)` → `formatUser`) unless the function binds that name itself: a parameter, declarator, assignment target, loop/catch/`with` variable is a value, not a reference. The binding tables are grammar data (node type → field holding the bound pattern; pattern type → fields to descend, `"*"` = all). Bindings are collected in the same walk as the calls and references are filtered once it ends, so output order is unchanged. A declarator whose value is itself a function (`const onClick = () => …`) stays a reference. Without this about a quarter of all extracted "calls" on real repositories were variables, which the linker then bound by name or through a file-wide factory alias (`foo(client)` → `IxClient`).
   - A reference carries `CallInfo.passed` — `argument`, or `attribute`, `return`, `property` from `collectExtraCalls` — which the linker turns into `relation: "passes"`; a name the body also invokes stays one call (a map's value excepted). `property` names are also read at a module's top level (`extractTopLevelCalls`), so a module-level map's values are `<setup>`'s. A value held under several keys is one claim per key.
   - **`passedArguments`** names the other handed-on argument shapes per grammar (`this.onResize`, Python `self.handle` and `target=worker`, Kotlin `::save`/`Club::save`, C# method groups `Register(Save)`); `ownMember` exempts the instance's own member from the bound-receiver skip.
   - **`destructuredFromCall`** names the locals a declarator destructures from a call (`const { save } = useClubActions()`): handed on, they are kept, and `classifyCalls` routes them into the factory's module (array elements bind by position, `[1]`, so they fall back to the factory).
   - Library-run callbacks (`CallInfo.libraryOption`), dispatch maps (`dispatch:object-map`) and maps handed down as props: [JavaScript](../plugins/javascript/AGENTS.md).
8. **`boundAt`** — per-site `boundLocally`: where the function-wide binding set is too coarse, the plugin answers for one call node; a site's answer is part of the dedup key, so two sites of one name stay two calls. For a dotted name it speaks of the head. See [JavaScript](../plugins/javascript/AGENTS.md) (`block-scope.ts`).
9. **`statedMember`** / **`importedMapMember`** — a member call whose leaf is a noise name (`map`, `send`, `filter`) is kept when the file states the receiver is a project value (a top-level binding in scope at the call — a parameter, local, loop or catch variable of that name is another value, `receiverReboundAt`; a local object literal holding the called key owns the call; `CallInfo.receiverRebound` stops a rebound head taking a same-file namesake's member), or, marked `CallInfo.mapMember`, when it reads a key off a name imported from a project file; the linker joins a `mapMember` call only through the exporting file's dispatch map.
10. **`NOISE_CALLS`** — method names to skip (`.then`, `.map`, `console.log`, …). Cross-language; centralize noise here, not per plugin.

`classifyCalls(calls, imports, language, variableAliases?)` runs **after** extraction. It mutates `CallInfo.kind` from `"internal"` to `"cross-file"`/`"api-call"`/`"database"` based on:
- Auto-imported globals from the plugin hook (e.g. Vue compiler macros) → `cross-file`
- Import specifier match → `cross-file`
- Qualified name root matches import/default/namespace → `cross-file`
- Variable alias lookup (`s = useStore()` then `s.x.y`) → `cross-file` (a plugin's `ast.variableAliases` hook)
- Plugin `qualifiedRootCandidates` transforms → `cross-file` (INFERRED)
- Root names one of the file's own definitions (`localSymbols`: functions, dotted-name roots like `requests` of `requests.get`, classes) → stays `internal`, before any name heuristic. `api-call`/`database` calls are skipped by both the symbol linker and the LSP enhancer, so a wrong label there is a link that can never form.
- Pattern match on `isApiCall` / `isDatabaseCall` → `api-call` / `database`. A `this.`/`self.` receiver is never `database` by its method name alone (`isDatabaseCall(…, byMethodName = false)`); a known DB client root still is. A bare call (`sum(xs)`) is never `database` by name, and `execute` is not an HTTP method name (`cursor.execute`, JDBC `stmt.execute`). A dotted root in a plugin's list (`http.client`, `urllib.request`) matches as a module-path prefix, not by its first segment.

## link-scoring.ts — file dependency graph

`buildLinkGraph(analyses)` produces weighted `LinkInfo[]`. Proximity:
- **1 (tight)** — lifecycle hooks, immediate imports (`useEffect`, `onMounted`)
- **2 (medium)** — watchers, computed, store use (`watch`, `useSelector`)
- **3 (loose)** — event handlers (`onClick`)

`resolveTarget(importSource, sourceFile, filePathMap)` resolves an import source to a file path. Handles:
- Relative imports (`./foo`)
- Package-qualified imports (`com.example.api.service.UserService`)
- Dotted module paths (`services.user_service`)
- Last-segment file basename matching
- A path written with its extension (C `#include "league/club.h"`, PHP `include 'inc/header.php'`) from no directory the importer or the root spells: the one file whose path ENDS with it, extension included (`uniquePathEnding`) — never the `club.c` that shares the header's stem; two files spelling it alike stay unresolved
- Skips known external packages (prefixes contributed by plugin metas via `registry.ts`)

## node-helpers.ts — tree-sitter AST utilities

All helpers take a `Node` (from `web-tree-sitter`). Prefer field-based access (`node.childForFieldName("name")`) over positional children — more robust across grammar versions.

Decorator extraction has per-language variants because grammars differ:
- `extractJsDecorators` — preceding siblings before the node
- `extractAnnotations` — `annotation` / `marker_annotation` children, also inside `modifiers` block
- `extractCsharpAttributes` — `attribute_list` → `attribute` children
- `extractPythonDecorators` — `decorator` children of `decorated_definition`

## Conventions

- **No IO** — these are pure AST/string helpers
- **Language-agnostic at the type level** — take `Language` as a parameter, dispatch internally
- **Don't add language-specific logic here** if only one language needs it; that goes in `plugins/<lang>/` instead
- **When adding a new language to `CALL_TYPES`**, also verify `NESTED_SCOPE_TYPES` covers its function/class/lambda nodes
- [route-paths.ts](route-paths.ts) holds the route-path joins (`joinRoutePath`, `joinRootedPath` — always rooted, empty segments dropped, `collapse` for the doubled-slash spelling —, `joinTrimmedPath` — one `/` between, no trailing one, `prefixOptional`/`collapse`); [split-top-level.ts](split-top-level.ts) is the one top-level splitter (`brackets`, `quotes`, `escapes`, `trim`, `tail`, `dropBlank`, `clamp`, `stopAtCloser`, `lineComment`, `anyOf` for several one-character separators; a multi-character `sep` such as `||` matches as a string). A plugin states the spelling it needs as options in a one-line wrapper; both have differential tests against the bodies they replaced — add the new spelling there before adding a variant to a plugin. A wrapper is named for its spelling (`splitBracketedArgs`, `splitGoArgs`, `splitPyTypeArgs`…), never `splitTopLevel`, which is only this function. [http-verbs.ts](http-verbs.ts) declares the seven verbs once, upper and lower case. `scripts/check-plugin-helpers.mjs` (run by `plugins/shared/plugin-helpers.test.ts`) fails on one helper body of 80+ normalized characters declared in two plugin folders — a one-line wrapper (`return shared(…);`) is exempt; a body left on purpose is named in `scripts/plugin-helpers-allow.json` with its reason (it is empty today). Kept apart from `splitTopLevel` with a comment: `destructuring` (an unterminated string or missing close is `null`) and `plugins/shared/code-lines` `splitArgs` (aligned offsets into two texts).
