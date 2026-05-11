# src/extractors/shared — Cross-language utilities

Utilities used by multiple language plugins. If something's only used by one language, put it in that plugin folder instead.

## Files

| File | Key exports | Used by |
|------|-------------|---------|
| [call-graph.ts](call-graph.ts) | `extractCalls`, `extractTopLevelCalls`, `classifyCalls`, `extractVariableAliases` | all tree-sitter plugins |
| [call-patterns.ts](call-patterns.ts) | `isApiCall`, `isDatabaseCall` | `classifyCalls` only |
| [link-scoring.ts](link-scoring.ts) | `buildLinkGraph`, `resolveTarget`, `buildFilePathMap` | `core/analyzer.ts`, `core/symbol-linker.ts` |
| [node-helpers.ts](node-helpers.ts) | `getVisibility`, `getNameFromNode`, `getCallName`, `stripQuotes`, decorator extractors | all tree-sitter plugins |
| [python-tokenizer.ts](python-tokenizer.ts) | `stripPythonNonCode` | `core/security-scanner.ts` |
| [interactive-elements.ts](interactive-elements.ts) | `extractInteractiveElements`, `extractVueInteractiveElements` | `core/analyzer.ts` |
| [sub-components.ts](sub-components.ts) | `extractSubComponents` | `core/analyzer.ts` |
| [events.ts](events.ts) | `extractEvents` | `core/analyzer.ts` |

## call-graph.ts — the core of call extraction

Three concepts:
1. **`CALL_TYPES`** — per-language set of AST node types that represent function calls. Add new languages here.
2. **`NESTED_SCOPE_TYPES`** — AST node types that start a new scope. `extractCalls` stops recursing when it hits one (so inner function bodies aren't mixed into outer function call lists).
3. **`NOISE_CALLS`** — method names to skip (`.then`, `.map`, `console.log`, etc.). Centralize noise here, not per-plugin.

`classifyCalls(calls, imports, language, variableAliases?)` runs **after** extraction. It mutates `CallInfo.kind` from `"internal"` to `"cross-file"`/`"api-call"`/`"database"` based on:
- Import specifier match → `cross-file`
- Qualified name root matches import/default/namespace → `cross-file`
- Variable alias lookup (`const s = useStore()` then `s.x.y`) → `cross-file`
- Language-specific resolution: Java instance variables (`userService` → `UserService`), Python snake_case → PascalCase, Pascal `F`-prefix
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
- Skips known external packages (see `EXTERNAL_PREFIXES`)

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
