# src/types — Shared type definitions

## analysis.ts

Single source of truth for all analysis types. If you're reading this to understand a field, the type is the definitive reference.

### Core types

- **`Language`** — union of all supported languages. Add new languages here first.
- **`FileAnalysis`** — per-file result. One JSON file produced per source file.
- **`ProjectAnalysis`** — aggregated project-level summary. Written as `project-summary.json`.

> **On-disk vs in-memory.** These types describe the **in-memory** shape (file paths as strings). On disk, `project-summary.json` is *normalized* by [../core/element-registry.ts](../core/element-registry.ts): symbol/graph nodes are interned into an `elements[]` registry, and remaining file references become `page_id` integers (an index into the top-level `files[]` array). `normalizeProject` encodes on write, `denormalizeProject` decodes on read — every consumer reads through the latter, so these types stay the single reference. A new path-bearing field is page-encoded by adding it to `rewritePageRefs`; a new symbol/graph field by extending the elements codec.

### Field groups

| Group | Types |
|-------|-------|
| Structure | `ImportInfo`, `ExportInfo`, `FunctionInfo`, `ClassInfo`, `ParamInfo`, `PropertyInfo` |
| Behavior | `CallInfo`, `RouteInfo`, `DataSourceInfo`, `DataMutationInfo` |
| UI | `SubComponentInfo`, `InteractiveElementInfo`, `EventInfo`, `ScreenInfo`, `ScreenComponentInfo` |
| Graph | `LinkInfo`, `SymbolLink`, `LinkProximity` |
| Advanced | `ComplexityInfo`, `PatternInfo`, `SecurityIssue`, `DuplicateGroup`, `LayerViolation`, `BlastRadiusInfo`, `HealthScore`, `Suggestion` |
| Framework | `FrameworkDetection` |
| LSP | `LspStats` |

## plugin.ts

Types for runtime-registered extractor plugins — `CaptureResult` for tree-sitter query results, plus the plugin interfaces.

## Conventions

- **Line numbers are 1-based** everywhere in these types. Tree-sitter uses 0-based internally — extractors convert at the boundary.
- **Paths are posix-style** (`/` separators) regardless of platform.
- **Extend `ProjectAnalysis` with optional fields** so old outputs continue to load. All advanced analysis fields (`healthScore`, `patterns`, etc.) are `?` optional.
- **`CallInfo.kind`** has exactly 4 values — don't add new ones without updating `classifyCalls()` in [../extractors/shared/call-graph.ts](../extractors/shared/call-graph.ts).
- **Never break existing fields.** Rename via deprecation: add the new field, keep the old one as a computed alias, plan removal later.
