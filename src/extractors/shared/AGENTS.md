# src/extractors/shared — Cross-language utilities

Utilities used by multiple language plugins. If something's only used by one language, put it in that plugin folder instead.

## Files

| File | Key exports | Used by |
|------|-------------|---------|
| [call-graph.ts](call-graph.ts) | `extractCalls`, `extractTopLevelCalls`, `classifyCalls`, `extractVariableAliases` | all tree-sitter plugins |
| [call-patterns.ts](call-patterns.ts) | `isApiCall`, `isDatabaseCall` (per-language roots pushed in by the registry from plugin metas) | `classifyCalls`, `plugins/javascript/data-sources` |
| [link-scoring.ts](link-scoring.ts) | `buildLinkGraph`, `resolveTarget`, `buildFilePathMap` | `core/analyzer.ts`, `core/symbol-linker.ts` |
| [node-helpers.ts](node-helpers.ts) | `getVisibility`, `getNameFromNode`, `getCallName`, `stripQuotes`, decorator extractors | all tree-sitter plugins |
| [builtin-types.ts](builtin-types.ts) | `isBuiltinType` (per-language sets pushed in by the registry from plugin metas), `COMMON_PRIMITIVES` | `type-parser`, `core/type-reference-extractor.ts` |
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
2. **`nestedScopeTypes`** — node types that start a new scope; `extractCalls` stops recursing at one. Unioned across plugins (grammar node names rarely collide).
3. **`resolveCallName`** — full name resolution for the language; plugins compose `genericResolveCallName(node, { calleeOverride?, extraCallee? })`.
4. **`collectExtraCalls`** — extra call shapes (JSX component refs, Python decorators).
5. **`classifyAutoImported`** / **`qualifiedRootCandidates`** — classification hooks (Vue macros; Java `userService`→`UserService`, Python snake→Pascal, Pascal `F`-strip).
6. **`NOISE_CALLS`** — method names to skip (`.then`, `.map`, `console.log`, etc.). Cross-language, stays here — centralize noise here, not per-plugin.

`classifyCalls(calls, imports, language, variableAliases?)` runs **after** extraction. It mutates `CallInfo.kind` from `"internal"` to `"cross-file"`/`"api-call"`/`"database"` based on:
- Auto-imported globals from the plugin hook (e.g. Vue compiler macros) → `cross-file`
- Import specifier match → `cross-file`
- Qualified name root matches import/default/namespace → `cross-file`
- Variable alias lookup (`const s = useStore()` then `s.x.y`) → `cross-file` (the alias walker is a JS plugin `ast.variableAliases` hook)
- Plugin `qualifiedRootCandidates` transforms → `cross-file` (INFERRED)
- Pattern match on `isApiCall` / `isDatabaseCall` → `api-call` / `database`

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
