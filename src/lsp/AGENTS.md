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
2. `LspManager.initialize(languages, files)` — returns at once when no language has a configured server; otherwise reads the Docker probe (`isDockerAvailable`: a socket `/_ping` on the endpoint `DOCKER_HOST` or the current context names, `docker info` bounded to 1.5 s only for tcp/ssh/unknown ones) that `analyzer.ts` started before `buildSymbolLinks` so the wait overlaps linking (`dockerProbe`); for each language present, builds the Docker image if missing, starts a container, opens all relevant files
3. **Phase A**: for each unresolved call (kind=cross-file with no text-based target), query `textDocument/definition` and create `SymbolLink`
4. **Phase B**: for each exported symbol, query `textDocument/references` and create reference links
5. `LspManager.shutdownAll()` — stops containers

**Query positions matter.** Both phases re-read the source line to aim at the right token (`SourceLineCache` +
`findTokenColumn` in [lsp-enhancer.ts](lsp-enhancer.ts)); out-of-project answers are dropped by `toHostPath`. The
reasons and `CLARIFYDOC_LSP_DEBUG=1` are in the doc comment of `enhanceWithLsp`.

## Definition sources

The passes ask a `DefinitionSource` (`initialize` → `clientFor(language)` → `shutdown`), never `LspManager` directly.
`dockerDefinitionSource` is the default; the others replay answers computed elsewhere and need no Docker:

- **Editor** — `lsp-update <dir> --emit-queries q.json` (`planDefinitionQueries`) writes the questions, the editor
  answers them, `lsp-update <dir> --answers a.json` replays them through `answersDefinitionSource` ([answers-source.ts](answers-source.ts):
  file shape, abstention on several distinct targets, no Phase B).
- **SCIP** — `lsp-update <dir> --scip index.scip` ([scip.ts](scip.ts): protobuf read by hand, `scipFileAnswers` streaming,
  `scipPathMapper`, roles, position encodings; `lspStats.source` is `scip`).
- **LSIF** — `--lsif dump.lsif` ([lsif.ts](lsif.ts), same path mapper; `lspStats.source` is `lsif`).

Both indexes go through `answersDefinitionSource`, so the same abstention and in-project rules hold. Phase C
(`recordImplementations`) asks `textDocument/implementation` at every call the dependency-injection resolver left on
an interface member and records the answers in `lsp-ground-truth.json` as `implementations`; it changes no link.
Links stay `resolvedBy: "lsp"`, `strategy: "lsp-definition"` (`lsp-compare` grades them alike); `lspStats.source` says
where they came from. Only the Docker source writes `lsp-ground-truth.json`.

## Surviving a re-analysis

`analyze` never rewrites `lsp-enhancement.json`, and a delta older than the summary is not merged — its graphs describe code that has changed. It also records the links layer 2 added and the manifest SHA-256 of each file they join (`added`, written when the analysis has a manifest, i.e. an incremental run). `loadReportSummary` carries over the added links whose two files still hash the same into the fresh `symbolLinks` (`lspStats.carried`); the derived graphs wait for the next `lsp-update`.

## Ground truth export

`lsp-ground-truth.json` (next to `project-summary.json`, written by `analyze` with LSP and by `lsp-update`) keeps every
query and raw answer, including **unresolved queries** (`target: null`) and **pre-redirect targets**
(`redirectedTarget`), so the text linker can be measured without re-running Docker (see the root AGENTS.md,
"Measuring linker quality"; record types `LspDefinitionRecord` / `LspReferenceRecord` in `types/analysis.ts`).

Docker containers are tagged `clarifydoc-lsp-<lang>`. Images are cached between runs. Cleanup handlers stop containers on SIGINT/SIGTERM.

## Supported languages

See [lsp-configs.ts](lsp-configs.ts): one config per server — TypeScript (tsserver), Python (Pyright), Ruby (Solargraph), plus servers whose setup is stated in their plugin's file: [Java and Kotlin](../extractors/plugins/java-kotlin/AGENTS.md) (jdtls, kotlin-language-server), [C# and VB](../extractors/plugins/vb/AGENTS.md) (one Roslyn container for `.cs` and `.vb`), [Go](../extractors/plugins/go/AGENTS.md) (gopls), [Rust](../extractors/plugins/rust/AGENTS.md) (rust-analyzer), [PHP](../extractors/plugins/php/AGENTS.md) (Intelephense), [Pascal](../extractors/plugins/pascal/AGENTS.md) (`pasls`).

Each language has a Dockerfile in `../../docker/<lang>/`. A Dockerfile that downloads a native server picks the asset by BuildKit's `TARGETARCH` (`amd64` / `arm64`, the build fails on any other) and never hard-codes an architecture, so `docker build` produces an image for the host (dotnet: `linux-x64`/`linux-arm64` Roslyn zip; rust: `x86_64`/`aarch64-unknown-linux-gnu` rust-analyzer).

## Adding a new LSP server

1. Create `docker/<lang>/Dockerfile` with the language server at ENTRYPOINT (stdio mode)
2. Add entry to `LSP_CONFIGS` in [lsp-configs.ts](lsp-configs.ts):
   - `id`, `languageIds` (matches ClarifyDoc `Language`), `dockerImage`, `dockerfilePath`
   - `fileExtensions` — which files to open
   - `readOnly` — set false if server needs to write (e.g. jdtls .project, rust target/)
   - `network` — `none` by default (the container has no network); set `"bridge"` only for a server that restores packages to type-check (jdtls, Roslyn: measured offline, they lose most reference answers) and say so in `SECURITY.md`; `CLARIFYDOC_LSP_NETWORK=none|bridge` overrides every config for probing
   - `indexDelayMs` — how long to wait after opening files before querying (set per server in [lsp-configs.ts](lsp-configs.ts): 5 s for gopls, 10 s for jdtls, 15 s for rust-analyzer)
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
