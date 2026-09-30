# src/core — Analysis pipeline & analyzers

The analysis pipeline orchestrator and all cross-file analyzers live here. Pure functions in / out — no tree-sitter parsing happens at this layer (that's delegated to extractors).

**Core is language-agnostic.** Anything per-language — extensions, parse
strategy, builtin types, complexity tables, security rules, framework hints,
external-package prefixes, AST hooks — comes from the plugin registry
([../extractors/registry.ts](../extractors/registry.ts)), which aggregates each
plugin's `meta.ts`. Don't hardcode language names, ORMs, frameworks, or file
conventions here; ask the registry. Even a **cross-file** join that needs
language knowledge stays in the plugin: core calls a generic hook (e.g.
`reconcileProjectEntities` → each entity extractor's `reconcileProject`), it
never names the language. A `schema.rb` parser or a pluralization rule in
`src/core/` is a layering bug.

## Entry point

[analyzer.ts](analyzer.ts) exports `analyze(options)` — the full pipeline. It runs:

1. File discovery + framework detection
2. Parallel per-file analysis (tree-sitter + extractors, or regex fallback)
3. Post-analysis: component graph, link graph, symbol links
4. Optional LSP enhancement
5. Advanced analysis (complexity, patterns, duplicates, layer violations, blast radius, health, suggestions)
6. Write project summary + optional HTML report

Each step is gated behind the `ProgressReporter` — both verbose and non-verbose modes.

## Analyzers (post-analysis passes)

All take `FileAnalysis[]` and/or `componentGraph` and return typed results.

| File | Output | Depends on |
|------|--------|-----------|
| [symbol-linker.ts](symbol-linker.ts) | `SymbolLink[]` | A fallback cascade: direct, inheritance, injection (ctor params + properties + enclosing-method params), interface-redirect, deep-qualified, factory-via, ClassName.method, constructor (`new X`/bare class), package-qualified import head (file and dir), unique-global-leaf (evidenced and import-blind), generic type-argument — plus the route/spec/fan-out/reference producers in `buildSymbolLinks`. **Every link carries `strategy`** (`SymbolLinkStrategy` in `types/analysis.ts`) naming which of those produced it, and `relation` naming what kind of edge it is; both are set at each construction site and `relationForStrategy` derives the second from the first. Heuristic tiers are guarded: same sub-project only, never into test-fixture paths, registry `builtinMembers` stoplist (`set.add`, `s.strip`) |
| [blast-radius.ts](blast-radius.ts) | `BlastRadiusInfo[]` — downstream dependents, exported-symbol usage, plus `contextBurden`: the two-hop neighbourhood in BOTH directions with a line/token estimate (what must be read to edit the file safely) | reverse graph from componentGraph; `FileAnalysis.lineCount` for sizes |
| [complexity-analyzer.ts](complexity-analyzer.ts) | `FileComplexityInfo[]` — per function: cyclomatic, cognitive (branch + nesting penalty, `else if` continuations exempt, callbacks deepen), nesting depth, parameter count | tree-sitter AST (per-file); the plugin `complexity` spec (`branchNodes`, `logicalOps`, `nestingNodes`) |
| [control-flow.ts](control-flow.ts) | `Cfg` — one function's control-flow graph, built **on demand** and never written to `project-summary.json` ([control-flow-file.ts](control-flow-file.ts) is the per-file entry point, [control-flow-mermaid.ts](control-flow-mermaid.ts) renders it) | the same `findBodyNode` the complexity analyzer uses, plus the plugin `controlFlow` spec (node type → role). two gates in `control-flow.test.ts`: `cyclomaticFromCfg` must equal `computeComplexity` (sharp, but sees only what the complexity table counts), and `undrawnStructure` must come back empty (table-independent — required because Pascal's complexity table names node types its grammar lacks, so every Delphi function reports 1 and the arithmetic can never fail). TS/JS, C#, Python, PHP, Java, Kotlin, Pascal. A language with no grammar goes through [control-flow-regex.ts](control-flow-regex.ts) instead — a line scanner that synthesizes the same node shapes for the same interpreter, gated by measuring it against the parser where both exist |
| [pattern-detector.ts](pattern-detector.ts) | `PatternInfo[]` | classes, functions, imports |
| [responsibility-profile.ts](responsibility-profile.ts) | `ResponsibilityProfile[]` — per file: boundaries touched (database, http, queue, auth, logging, …), workflow roles, concern count, read/write/publish/serve flags with evidence | imports classified through the plugins' `knownPackages` tables + dataSources/routes/screens; core names no package |
| [security-scanner.ts](security-scanner.ts) | `SecurityIssue[]` | raw source text (regex-based) |
| [duplication-detector.ts](duplication-detector.ts) | `DuplicateGroup[]` | structural fingerprinting |
| [layer-analyzer.ts](layer-analyzer.ts) | `ArchLayer` map + violations | file paths + componentGraph; `.clarifydoc/config.json` `layers`/`exempt` overrides are consulted before the path heuristics (tests stay exempt first) |
| [refactor-pressure.ts](refactor-pressure.ts) | `RefactorPressureInfo[]` — per file: 0–100 composite of complexity, size, mixed concerns, coupling and churn, band, drivers, fired gates, confidence (= share of signal available) | complexity, blastRadius, responsibilityProfiles, fileChurn, layerViolations, componentGraph cycles; thresholds from `DEFAULT_REFACTOR_PRESSURE_CONFIG`, overridable in `.clarifydoc/config.json` (`project-config.ts`) |
| [health-scorer.ts](health-scorer.ts) | `HealthScore` | all other analyzers + Tarjan SCC for cycles |
| [suggestions-engine.ts](suggestions-engine.ts) | `Suggestion[]` | all other analyzers |

**Dependency order matters.** Health and suggestions depend on everything else. `findCircularDeps` is exported from `health-scorer.ts` and reused by suggestions-engine to avoid duplicate work.

## Per-file analysis & workers

- [file-analyzer.ts](file-analyzer.ts) — `analyzeFile(task)`: read + parse + run all extractors + write the per-file JSON. Pure per-file logic with no pipeline state, so it can run on any thread.
- [analyze-worker.ts](analyze-worker.ts) — worker_threads entry that wraps `analyzeFile`. Built as its own tsdown entry (`dist/analyze-worker.js`).
- [worker-pool.ts](worker-pool.ts) — `AnalysisWorkerPool`: spreads per-file analysis across cores for projects ≥200 files (override with `CLARIFYDOC_WORKERS=<n>`, `0` disables). Falls back to in-process analysis when workers can't start, and re-runs a crashed worker's task in-process.

## Discovery & IO

- [file-discovery.ts](file-discovery.ts) — fast-glob by extension. The `EXTENSION_MAP` is the source of truth for which extensions are analyzed.
- [clarifydoc-ignore.ts](clarifydoc-ignore.ts) — `.clarifydocignore` / `.clarifydoc/ignore` in gitignore syntax, inherited up to the nearest project root. Anchoring is decided in `parseIgnorePattern`, not while matching: a pattern with a `/` in it is fixed to the ignore file's directory (`/dist` leaves `src/dist/` alone), a slash-less one matches that name at any depth. Last match wins, and a file CAN be re-included under an excluded parent — a deliberate divergence from git, pinned by a test. `fnmatch` here is the only glob engine; `project-config.ts` shares it.
- [framework-detector.ts](framework-detector.ts) — gathers `ProjectInfo` (package.json, pom.xml, build.gradle, …) per project/sub-project root and runs the plugin-contributed rules (`plugins/<lang>/frameworks.ts`, aggregated into the registry's `FRAMEWORK_RULES`). Produces `FrameworkDetection[]`, sorted by id; core knows no framework names.
- [deployment.ts](deployment.ts) — compose-manifest deployment topology (`ProjectAnalysis.deployment`): parses docker-compose/compose files with a built-in YAML-subset parser, classifies services (app vs datastore/queue/cache), matches app services to sub-projects (entrypoint dll / image tail / marker basenames), and derives service→service edges from env evidence (api-key handshake per file, connection strings literal-first, URL/issuer vars, bus/cache attachment). Powers the report's Context (C1) / Deployment (C2) architecture levels.
- [output-writer.ts](output-writer.ts) — writes per-file JSONs + `project-summary.json` (+ `lsp-enhancement.json` / `lsp-ground-truth.json` when LSP runs).
- [element-registry.ts](element-registry.ts) — the disk-I/O codec. `normalizeProject` (write) lifts repeated nodes into two registries — `elements[]` (symbol-level `file::symbol` ids) and `files[]` page_ids (a file's index, used everywhere a path was repeated); `denormalizeProject` (read) reverses it. In-memory shapes are untouched; all readers go through `denormalizeProject`. A round-trip test over every fixture is the regression gate — adding a path-bearing `ProjectAnalysis` field means adding it to `rewritePageRefs`.
- [project-config.ts](project-config.ts) — reads `<root>/.clarifydoc/config.json` (optional, never fatal): per-repository `layers` (glob → ArchLayer, first match wins), `exempt` and `generated` globs, and `refactorPressure` thresholds. Owners of a section resolve it (`resolveArchitectureOverrides`, `resolveRefactorPressureConfig`); unknown keys and bad values become progress warnings and defaults are kept. `matchesAnyGlob` is the one glob test (ignore-file dialect; anchoring is read off the pattern, so a slash-less pattern also matches the bare file name and one carrying a `/` does not). The analyzer loads it once, before the generated/unauthored filter, so `generated` globs reach every quality signal.
- [regex-extractor.ts](regex-extractor.ts) — thin dispatcher for regex-only languages. Real logic lives in `src/extractors/plugins/<lang>/`.

## Report

**One renderer, two packagings.** The React viewer in `application/spa/src/report/` is THE report renderer. `report.html` is that same viewer built into a single self-contained file (react + d3 + dagre + css inlined, fully offline) with the payload JSON injected — report features are written ONCE, in the SPA viewer, then `npm run build:viewer` refreshes the standalone template.

- `html-report.ts` — `generateHtmlReport` loads the prebuilt template from `html-report/viewer-assets/report-template.html` (committed; built by `npm run build:viewer`; mirrored into `dist/` by the root tsdown `onSuccess` hook) and swaps `__CLARIFYDOC_TITLE__` / `__CLARIFYDOC_PAYLOAD__`. The payload embeds as **gzip+base64** (`encodeReportPayload`; ~10x smaller than inline JSON, no `<` so no HTML-escaping concerns) and `standalone.tsx` inflates it in the browser via the native `DecompressionStream`. Token replace uses a replacer *function* so `$&` can't corrupt. Also writes `report-data.json` (plain JSON — the server slices it) alongside `report.html`.
- `report-payload.ts` — `buildReportPayload(summary)` reshapes a (denormalized) `ProjectAnalysis` into the `ReportPayload` the viewer consumes; `loadReportSummary(dir)` / `loadReportPayload(dir)` read it from disk (with the `lsp-enhancement.json` merge). The payload carries `deferredFields` so the server's slice cache follows the producer's list.
- `smoke.test.ts` renders a minimal report end-to-end and round-trips hostile payload content through the encoder; `scripts/compare-report-payload.mjs` regenerates every corpus scan and verifies embedded-payload ↔ report-data.json parity (plus prints sizes).

## Adding a new analyzer

1. Create `src/core/my-analyzer.ts` exporting a pure function `analyzeMyThing(input): MyResult[]`
2. Add the return type to [../types/analysis.ts](../types/analysis.ts) and add an optional field to `ProjectAnalysis`
3. Wire into `analyzer.ts` post-analysis section (step 4c)
4. Pass data to `suggestions-engine.ts` if it should drive suggestions
5. Add the view to the SPA report viewer (`application/spa/src/report/` — new tab in `ReportViewer.tsx` TABS + a tab component), then `npm run build:viewer` to refresh the standalone template
6. Add exports to [../index.ts](../index.ts) if public API

## Conventions

- **Pure functions** — no file IO except `output-writer.ts` and `html-report.ts`. Input is `FileAnalysis[]`, output is typed results.
- **Optional fields** — new fields on `ProjectAnalysis` should be optional so old `project-summary.json` files still load.
- **Progress reporting** — use the `ProgressReporter` class in `analyzer.ts`, not `console.log` directly.
- **BFS with index pointer** — never use `Array.shift()` for BFS queues (it's O(n)); use `let qi = 0; while (qi < queue.length) { ... queue[qi++]; ... }`.
