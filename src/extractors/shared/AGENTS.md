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
| [destructuring.ts](destructuring.ts) | `destructuredProps`, `patternBindings` — a destructuring parameter named by its pattern (`{ table, onRemove: remove }`): the props it takes, the names it binds | `core/file-analyzer` (a call shadowed by a parameter), `plugins/javascript/dispatch` (prop callbacks) |
| [type-ref-helpers.ts](type-ref-helpers.ts) | `emitParsed`, `findChildByType`, `lineOf` | `plugins/<lang>/type-references.ts` walkers |

Formerly-shared but language-specific extractors now live in their plugins and
are wired via each meta's `ast` hooks: `interactive-elements.ts`,
`sub-components.ts`, `events.ts` (→ `plugins/javascript/`),
`python-tokenizer.ts` (→ `plugins/python/`), and the type-reference walkers
(→ `plugins/<lang>/type-references.ts`).

## call-graph.ts — the core of call extraction

The walkers and the classification pipeline are generic; everything
language-specific comes from each plugin's `meta.calls`
(`CallExtractionHooks`), pushed in by the registry:
1. **`callNodeTypes`** — AST node types that represent function calls (per plugin).
2. **`nestedScopeTypes`** — node types that start a new scope; `extractCalls` stops recursing at one. Read per language, never as a union over plugins. A function expression (`anonymousScopeTypes`) walked on its parent's behalf unless a declarator names it; `localDeclarationTypes` (Java `local_variable_declaration`, C# `local_declaration_statement`) says a declarator in a local declaration names a value, not a function, so `Runnable r = () -> club.save();` leaves `club.save` on the enclosing method's row (a field's lambda stays out).
3. **`resolveCallName`** — full name resolution for the language; plugins compose `genericResolveCallName(node, { calleeOverride?, extraCallee? })`.
4. **`collectExtraCalls`** — extra call shapes (JSX component refs, Python decorators).
4b. **`heldFunction`** — a function expression the plugin extracts as a function of its own though no declarator names it: a callback handed on to run later (JS: a dialog output's `subscribe(() => …)` → `<ClubEditDialog@saved@12>`, an `on[A-Z]` option of a component the script opens → `<ConfirmBox:onConfirm@14>`, a member assigned in a function → `<toast.action@17>`, an object of a declared array → `<items[].run@3>`, a watcher or effect callback a write in the file re-runs → `<watch@21>`, `<useEffect@7>`, `<effect@15>`, see `FileAnalysis.reactiveCells`; an option callback a library object runs from its methods → `<useVueTable:onPaginationChange@21>`, see below). The walk stops there and records the enclosing function handing it on (`passed: "argument"`; module code hands it on too, from `<setup>`), so reach keeps the writer's calls one `passes` hop further, while whatever joins a later run (an emit, a prop call, a member call) lands on the callback alone. Complexity skips them (`<…@line>`): the writer's metric already counts the body. Ordinary inline arrows (`onClick={() => save()}`, a `useEffect` nothing in the file re-runs, `.then`) stay the writer's.
5. **`classifyAutoImported`** / **`qualifiedRootCandidates`** — classification hooks (Vue macros; Java `userService`→`UserService`, Python snake→Pascal, Pascal `F`-strip).
5b. **`callbackArgNodeTypes`** + **`bindingSites`** / **`bindingPatterns`** — an identifier passed as an argument is recorded as a call (`items.map(formatUser)` → `formatUser`) *unless the function binds that name itself*: a parameter, declarator, assignment target, loop/catch/`with` variable is a value, not a reference. The binding tables are grammar data (node type → field holding the bound pattern; pattern type → fields to descend, `"*"` = all), each language's own, like the callback node types (grammars share node names — `assignment_expression` is JS and Java — and a union over the loaded plugins made a file's calls depend on what its worker had read before); bindings are collected in the same walk as the calls and references are filtered once it ends, so output order is unchanged. A declarator whose value is itself a function (`const onClick = () => …`) stays a reference. Without this about a quarter of all extracted "calls" on real repos (26–27% on three measured) were variables, which the linker then bound by name or through a file-wide factory alias (`foo(client)` → `IxClient`). A reference is recorded with `CallInfo.passed` (`argument`; `attribute`, `return` and `property` from `collectExtraCalls` — JSX attribute values, a hook's returned object or array, a dispatch map's values `const ACTIONS = { save: saveClub }` with `returnedAs: "ACTIONS.save"`), which the linker turns into `relation: "passes"`; a name the body also invokes stays one call (a map's value excepted). `property` names are also read at a module's top level (`extractTopLevelCalls`), so a module-level map's values are `<setup>`'s; the linker then joins `ACTIONS.save()` to that key's function and `ACTIONS[kind]()` (the JS call name `ACTIONS[]`) to each of the map's, INFERRED (`dispatch:object-map`). A value a LIBRARY runs from the holder's method carries `CallInfo.libraryOption` (addResult's `extra`): the JS plugin's knowledge table ([library-callbacks.ts](../plugins/javascript/library-callbacks.ts) — TanStack Table `on…Change` options under `table.nextPage`/`setSorting`…) holds `useVueTable({ onPaginationChange })` under each method running it, only for a factory imported from the library's package and an option the literal writes; those links are INFERRED `dispatch:library-option`, and a child handed the object as a prop gets each method as a `functionProps` entry (`table.nextPage`). The table also names its columns' and rows' methods (`members`: `header.column.toggleSorting()`/`getToggleSortingHandler()` → `onSortingChange`, `toggleVisibility` → `onColumnVisibilityChange`, `toggleSelected` → `onRowSelectionChange`, `toggleExpanded` → `onExpandedChange`), held as `table.column.toggleSorting`; a local derived from the holder — a Vue `v-for` over `table.getHeaderGroups()`/`headerGroup.headers`, a `.map` callback parameter of the holder's results — holds them again under its own name (`header.column.toggleSorting`, `header.toggleSorting`), which the linker joins by the member path (`DEEP_MEMBER_CALL`, only to an entry held under exactly that path in the caller's file) and which a child handed the local (`:header="header"`, `header={header}`) gets as props. TanStack Query's `useMutation` is a library object too (`mutationFn` ← `mutate`/`mutateAsync`; the callback is a held function, and `paramOrigins` follows its `invoked via mutate` parameter back through the `m.mutate(x)` link). A project dispatch map handed down as a prop (`:actions="ACTIONS"`, `actions={ACTIONS}`, [dispatch-map-props.ts](../plugins/javascript/dispatch-map-props.ts)) is one `functionProps` entry per held function (`actions.save`), the handler imported when the file imports it (`FunctionPropBinding.handlerImport`, resolved by the prop-callback resolver); a function the callback hands on counts as its writer's calls in the duplicate detector (`withHeldCalls`). A value held under several keys is one claim per key. **`passedArguments`** names the other handed-on argument shapes per grammar (`this.onResize`, Python `self.handle` and `target=worker`, Kotlin `::save`/`Club::save`, C# method groups `Register(Save)`); `ownMember` exempts the instance's own member from the bound-receiver skip. **`destructuredFromCall`** names the locals a declarator destructures from a call (`const { save } = useClubActions()`): handed on, they are kept, and `classifyCalls` routes them into the factory's module (array elements bind by position, `[1]`, so they fall back to the factory).
5c. **`boundAt`** — per-site `boundLocally`: where the function-wide binding set is too coarse (JS: `{ const save = cfg.save; save() }` beside a sibling `save()` of the module's), the plugin answers for one call node; a site's answer is part of the dedup key, so two sites of one name stay two calls. For a dotted name it speaks of the head, true only where a nested block's untyped declaration shadows a parameter (the linker then refuses the parameter's type for that call). [javascript/block-scope.ts](../plugins/javascript/block-scope.ts).
5d. **`statedMember`** / **`importedMapMember`** — a member call whose leaf is a noise name (`map`, `send`, `filter`) is kept when the file states the receiver is a project value (`const ACTIONS = { send: sendClub }`), or, marked `CallInfo.mapMember`, when it reads a key off a name imported from a project file; the linker joins a `mapMember` call only through the exporting file's dispatch map and through no other strategy, so an imported array's `.map` links nothing.
6. **`NOISE_CALLS`** — method names to skip (`.then`, `.map`, `console.log`, etc.). Cross-language, stays here — centralize noise here, not per-plugin.

`classifyCalls(calls, imports, language, variableAliases?)` runs **after** extraction. It mutates `CallInfo.kind` from `"internal"` to `"cross-file"`/`"api-call"`/`"database"` based on:
- Auto-imported globals from the plugin hook (e.g. Vue compiler macros) → `cross-file`
- Import specifier match → `cross-file`
- Qualified name root matches import/default/namespace → `cross-file`
- Variable alias lookup (`const s = useStore()` then `s.x.y`) → `cross-file` (the alias walker is a JS plugin `ast.variableAliases` hook)
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
