# src/extractors — Per-language extraction

Everything that walks an AST or regex-scans source text to pull out structured data. No cross-file analysis happens here — that's `src/core/`.

## Structure

```
extractors/
├── imports-exports/       plugin interface + dispatcher
├── functions-classes/     plugin interface + dispatcher
├── data-sources/          plugin interface + dispatcher (API calls, state hooks, ORM queries)
├── data-mutations/        plugin interface + dispatcher (setState, dispatch, assignments)
├── routes/                framework-specific route extractors (no plugin base — per-framework files)
├── plugins/               per-language implementations (see plugins/AGENTS.md)
└── shared/                cross-plugin utilities (call graph, link scoring, helpers)
```

Each of `imports-exports`, `functions-classes`, `data-sources`, `data-mutations` has:
- `base.ts` — abstract class defining the plugin interface
- `index.ts` — language-keyed dispatcher + `register*Extractor()` runtime registration

## The plugin pattern

```ts
// base.ts — abstract contract
export abstract class FunctionClassExtractor {
  abstract readonly languages: Language[];
  extractFunctions(tree, sourceText): FunctionInfo[] { ... }
  extractClasses(tree, sourceText): ClassInfo[] { ... }
  protected abstract collectFunctions(node, functions): void;
  protected abstract collectClasses(node, classes): void;
}

// index.ts — dispatcher
const extractorMap = new Map<Language, FunctionClassExtractor>();
for (const ext of extractors) for (const lang of ext.languages) extractorMap.set(lang, ext);

export function extractFunctions(tree, sourceText, language): FunctionInfo[] {
  return extractorMap.get(language)?.extractFunctions(tree, sourceText) ?? [];
}
```

## shared/ utilities

| File | Purpose |
|------|---------|
| [call-graph.ts](shared/call-graph.ts) | `extractCalls(body, language)` — main function-call walker. `classifyCalls(calls, imports, lang)` — sets `kind` to `cross-file`/`internal`/`api-call`/`database`. `extractVariableAliases` — `const s = useStore()` → maps `s` to import source |
| [call-patterns.ts](shared/call-patterns.ts) | `isApiCall(name)`, `isDatabaseCall(name)` — pattern matchers used by `classifyCalls` |
| [link-scoring.ts](shared/link-scoring.ts) | `buildLinkGraph(analyses)` — file → file edges with proximity (1=tight, 2=medium, 3=loose). `resolveTarget(importSource, sourceFile, filePathMap)` — turns `"./foo"` or `"com.example.Foo"` into a file path. `buildFilePathMap` — index for fast resolution. |
| [node-helpers.ts](shared/node-helpers.ts) | Tree-sitter AST utilities: `getVisibility`, `getNameFromNode`, `getCallName`, `extractJsDecorators`, `extractAnnotations`, `extractCsharpAttributes`, `extractPythonDecorators` |
| [python-tokenizer.ts](shared/python-tokenizer.ts) | `stripPythonNonCode(content)` — blanks out strings, docstrings, comments while preserving line positions. Used to eliminate false positives in regex scanning. |
| [interactive-elements.ts](shared/interactive-elements.ts) | JSX/Vue/Svelte button/input/form/link extraction |
| [sub-components.ts](shared/sub-components.ts) | React/Vue child component references |
| [events.ts](shared/events.ts) | Vue emit / Svelte dispatch extraction |

## routes/

No plugin base class — each framework has its own file:
- `javascript/routes/express.ts`, `react-router.ts`, `nestjs.ts`, `vue-router.ts`
- `python/routes.ts` (Flask, FastAPI, Django)
- `csharp/routes/aspnet.ts`
- `java-kotlin/routes/spring.ts`
- `pascal/routes.ts`

Regex-path languages (Go, Ruby, PHP) extract routes inside their `plugins/<lang>/index.ts` via `RegexLangSpec.extractRoutes`.

## Conventions

- Extractors return **raw extractions** — call classification (internal vs cross-file) happens in `classifyCalls()` after extraction
- Line numbers are **1-based** in output (tree-sitter is 0-based — convert: `node.startPosition.row + 1`)
- Extractors should never call each other directly; they communicate via `FileAnalysis` fields
- Noise filtering (skip `console.log`, `.map`, `.filter`, etc.) is centralized in `call-graph.ts` `NOISE_CALLS`
