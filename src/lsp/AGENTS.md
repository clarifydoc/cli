# src/lsp — LSP-based symbol resolution via Docker

Optional enhancement that starts language servers in Docker containers and queries `textDocument/definition` and `textDocument/references` to resolve cross-file calls that the text-based symbol linker missed.

## Components

| File | Purpose |
|------|---------|
| [lsp-enhancer.ts](lsp-enhancer.ts) | Orchestration: `enhanceWithLsp()` — the entry point |
| [lsp-manager.ts](lsp-manager.ts) | Manages lifecycles: build images, start containers, init LSP clients, shutdown |
| [lsp-client.ts](lsp-client.ts) | Minimal LSP JSON-RPC client — sends requests, parses responses |
| [lsp-configs.ts](lsp-configs.ts) | Per-language Docker image + server config |
| [docker-runner.ts](docker-runner.ts) | Spawns `docker build`, `docker run`; tracks running containers for cleanup |
| [answers-source.ts](answers-source.ts) | A `DefinitionSource` that replays answers computed elsewhere (an editor's language servers) |

## Flow

1. `analyzer.ts` calls `enhanceWithLsp(options)` after text-based `buildSymbolLinks`
2. `LspManager.initialize(languages, files)` — for each language present, builds the Docker image if missing, starts a container, opens all relevant files
3. **Phase A**: for each unresolved call (kind=cross-file with no text-based target), query `textDocument/definition` and create `SymbolLink`
4. **Phase B**: for each exported symbol, query `textDocument/references` and create reference links
5. `LspManager.shutdownAll()` — stops containers

**Query positions matter.** LSP answers "the symbol at this exact position", so both phases re-read the source line to aim at the right token (`SourceLineCache` + `findTokenColumn` in [lsp-enhancer.ts](lsp-enhancer.ts)): definitions target the *leaf* identifier of the call (`svc.ListUsers` → `ListUsers`; at the expression's start column servers resolve the receiver and answer with its field/param/import declaration), references target the symbol's name on its declaration line (column 0 is a keyword like `func`/`public` — most servers return nothing there). Out-of-project answers (stdlib/framework) are dropped by `toHostPath`, so external calls record `target: null` in the ground truth. Set `CLARIFYDOC_LSP_DEBUG=1` to log raw definition responses and per-query failures.

## Definition sources

The passes ask a `DefinitionSource` (`initialize` → `clientFor(language)` → `shutdown`), never `LspManager` directly. `dockerDefinitionSource` is the default. An editor already runs the same servers, so it can stand in without Docker:

1. `lsp-update <dir> --emit-queries q.json` — `planDefinitionQueries` writes Phase A's questions (file, 1-based line, 0-based column at the leaf token, call name, language) and starts nothing.
2. The editor answers each with its own definition provider and writes `{ source: "editor", servers, answers: [{ file, line, column, targets: [{ file, line }] }] }` — every location it got, project-relative, `[]` for none; questions it did not get to are left out.
3. `lsp-update <dir> --answers a.json` — `answersDefinitionSource` replays them. More than one distinct target **abstains** (two providers, an overload set: layer 2 only adds links it can stand behind); a question left out is skipped, not a miss; paths outside the project are dropped on read. The source answers no references, so Phase B does not run.

A SCIP index answers the same questions without a server (`lsp-update <dir> --scip index.scip`, [scip.ts](scip.ts)): the occurrence at a question's position names a symbol, and the occurrence that DEFINES it is the target — `local N` symbols within their document, a symbol only a dependency defines gives none. The protobuf is read by hand (the few fields used; a truncated index throws), and `scipPathMapper` adds or strips the directory prefix that names the most analysis files when the index was built at another root. The result goes through `answersDefinitionSource`, so the same abstention and in-project rules hold; `lspStats.source` is `scip`, the servers the indexer's name.

Links stay `resolvedBy: "lsp"`, `strategy: "lsp-definition"` — it is a language server's answer either way, and `lsp-compare` grades them alike; `lspStats.source` says where they came from. Only the Docker source writes `lsp-ground-truth.json`: an editor run is budgeted and must not overwrite a complete capture.

## Surviving a re-analysis

`analyze` never rewrites `lsp-enhancement.json`, and a delta older than the summary is not merged — its graphs describe code that has changed. It also records the links layer 2 added and the manifest SHA-256 of each file they join (`added`, written when the analysis has a manifest, i.e. an incremental run). `loadReportSummary` carries over the added links whose two files still hash the same into the fresh `symbolLinks` (`lspStats.carried`); the derived graphs wait for the next `lsp-update`.

## Ground truth export

Every query and its raw answer is recorded (`LspDefinitionRecord` / `LspReferenceRecord` in `types/analysis.ts`) and written to `lsp-ground-truth.json` next to `project-summary.json` — by both `analyze` (LSP enabled) and `lsp-update`. Unlike `lsp-enhancement.json` (merged links), it keeps **unresolved queries** (`target: null`) and **pre-redirect targets** (`redirectedTarget` holds the rewrite), so the text linker can be measured against what LSP resolved without re-running Docker: capture the ground truth
once, improve the text linker, re-run the text analysis, and bucket each LSP-resolved call as matched, conflicting
or missed by the text linker.

Docker containers are tagged `clarifydoc-lsp-<lang>`. Images are cached between runs. Cleanup handlers stop containers on SIGINT/SIGTERM.

## Supported languages

See [lsp-configs.ts](lsp-configs.ts). Currently: TypeScript (tsserver), Python (Pyright), Java (jdtls), .NET C#/VB (Roslyn `Microsoft.CodeAnalysis.LanguageServer` — `misterkiem/roslyn-plusvb` fork that patches VB libs into the upstream server; single container serves both `.cs` and `.vb`), Kotlin (kotlin-language-server), Go (gopls), Rust (rust-analyzer), Ruby (Solargraph), PHP (Intelephense), Pascal/Delphi (`genericptr/pascal-language-server` — FPC-based `pasls`, built from source against Lazarus trunk CodeTools; handles `.pas/.pp/.dpr/.dpk/.lpr/.inc` in Delphi mode, but RTL-only: Delphi-exclusive namespaces like `VCL.*`/`FMX.*` won't fully resolve).

Each language has a Dockerfile in `../../docker/<lang>/`.

## Adding a new LSP server

1. Create `docker/<lang>/Dockerfile` with the language server at ENTRYPOINT (stdio mode)
2. Add entry to `LSP_CONFIGS` in [lsp-configs.ts](lsp-configs.ts):
   - `id`, `languageIds` (matches ClarifyDoc `Language`), `dockerImage`, `dockerfilePath`
   - `fileExtensions` — which files to open
   - `readOnly` — set false if server needs to write (e.g. jdtls .project, rust target/)
   - `indexDelayMs` — how long to wait after opening files before querying (5s for gopls, 10s for jdtls, 15s for rust-analyzer)
3. Add language ID mapping in `LANGUAGE_ID_MAP` in [lsp-manager.ts](lsp-manager.ts)
4. Add extension-to-languageId mapping in `extensionToLanguageId()` in [lsp-manager.ts](lsp-manager.ts)

## Gotchas

- **Windows paths** — LSP uses `file://` URIs; `lsp-client.ts` handles URI conversion
- **Container startup** — some servers (jdtls, rust-analyzer) need significant warmup time; set `indexDelayMs` accordingly
- **Connection closes** — usually means the server needs a project manifest (cargo.toml, pom.xml) or writable mount
- **Timeout** — default 60s per LSP init; configurable via `--lsp-timeout` CLI flag
- **Graceful degradation** — if Docker is unavailable or a server fails to start, LSP enhancement is skipped silently (warning only)

## Conventions

- LSP enhancement is **additive** — it only adds links, never removes text-based ones
- `resolvedBy: "lsp"` field on `SymbolLink` marks LSP-resolved links. `"text"` is never actually
  written, so the field is really present-or-absent; `strategy` (`lsp-definition` /
  `lsp-reference`) is the precise form. `redirectThroughInterface` re-tags the links it
  re-aims — a spread that kept the old tag would be wrong about what resolved the target.
- Individual request failures are swallowed (one bad file shouldn't abort the whole pass)
