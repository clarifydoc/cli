# Pascal plugin (Delphi, Free Pascal / Lazarus, `.dfm`)

Reads Pascal units and programs (`.pas`, `.pp`, `.lpr`, `.dpr`, `.dpk`) with tree-sitter (`tree-sitter-pascal`, wasm built by the grammar setup; `.pas` is in `FLAT_TREE_LANGUAGES`), and the form resources `.dfm` / `.lfm` / `.fmx` through a custom recursive-descent parser (a second manifest, `dfm`). Both manifests are family `pascal`. Cross-language mechanisms: [../AGENTS.md](../AGENTS.md), [../../../core/AGENTS.md](../../../core/AGENTS.md).

## File map

Each file's header comment holds its rules.

- [manifest.ts](manifest.ts) — both static tiers: flags (`caseInsensitiveNames`, `importsShareScope`, `constructorCalls`, `dispatchLanguages`), project markers, external units, read-name linking, the `dfm` manifest. [meta.ts](meta.ts) — runtime tiers. [frameworks.ts](frameworks.ts) — framework rules (attached to the `pascal` meta only).
- Front end: [directives.ts](directives.ts) (conditional compilation rewritten in `preprocess`), [functions-classes.ts](functions-classes.ts), [imports-exports.ts](imports-exports.ts) (`uses X in 'path'`), [search-paths.ts](search-paths.ts) (build-file unit search paths), [module-bindings.ts](module-bindings.ts) (unit-level typed variables), [companion.ts](companion.ts) (form ↔ unit by basename), [call-hooks.ts](call-hooks.ts).
- Forms: the parser is [../../../parsers/dfm-parser.ts](../../../parsers/dfm-parser.ts); [ui-bridge.ts](ui-bridge.ts) (`.dfm` handler → form method), [dfm-entities.ts](dfm-entities.ts) (tables rebuilt from datasets).
- [di.ts](di.ts) (Spring4D), [routes.ts](routes.ts) (DataSnap, RAD Server), [data-sources.ts](data-sources.ts), [data-mutations.ts](data-mutations.ts), [reachability.ts](reachability.ts) (exact `uses` graph).

## Rules

- Receiver gating: data access and mutation readers act only on dataset/connection-shaped receivers; substring matching floods desktop code with phantom accesses.
- Facts only: DI and read-name links are decided by core, never the plugin.
- Extra `.dfm` details: the parser ([../../../parsers/dfm-parser.ts](../../../parsers/dfm-parser.ts)) produces `ScreenInfo` with a nested `ScreenComponentInfo` tree. A caption is a Pascal string literal decoded (`'caf'#233' squad'` → `café squad`, `''` → `'`). A component's `dataBindings` add what it shows or runs to its data links: `Action=`, `DataField=` / `FieldName=` and the DevExpress `DataBinding.` spellings (screen bindings only, never data sources). `origin` is a place stated without a size (an auto-sized control, or a non-visual component's place on the design surface); `constraints` are what the form holds a field to (`MinValue`/`MaxValue`, `MaxLength`, `ReadOnly`, `Required`, `Enabled = False`, formats and masks, on the control or its `Properties.`); an event set on a sub-object (`Properties.OnValidate`) is among the component's `events`, never an interactive element.

## Control flow and complexity

Pascal has a tree-sitter control-flow builder. Its complexity table names node types its grammar lacks, so every Delphi function reports 1 and `cyclomaticFromCfg` could never disagree with `computeComplexity`; the gate that guards Pascal is therefore `undrawnStructure` (table-independent: every construct in the body has a node in the graph), not the cyclomatic equality.

## Language server

`genericptr/pascal-language-server` — FPC-based `pasls`, built from source against Lazarus trunk CodeTools; handles `.pas/.pp/.dpr/.dpk/.lpr/.inc` in Delphi mode, but RTL-only: Delphi-exclusive namespaces like `VCL.*` / `FMX.*` do not fully resolve. See [../../../lsp/AGENTS.md](../../../lsp/AGENTS.md).
