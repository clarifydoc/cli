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

## Flow

1. `analyzer.ts` calls `enhanceWithLsp(options)` after text-based `buildSymbolLinks`
2. `LspManager.initialize(languages, files)` — for each language present, builds the Docker image if missing, starts a container, opens all relevant files
3. **Phase A**: for each unresolved call (kind=cross-file with no text-based target), query `textDocument/definition` and create `SymbolLink`
4. **Phase B**: for each exported symbol, query `textDocument/references` and create reference links
5. `LspManager.shutdownAll()` — stops containers

Docker containers are tagged `reversedoc-lsp-<lang>`. Images are cached between runs. Cleanup handlers stop containers on SIGINT/SIGTERM.

## Supported languages

See [lsp-configs.ts](lsp-configs.ts). Currently: TypeScript (tsserver), Python (Pyright), Java (jdtls), C# (OmniSharp), Kotlin (kotlin-language-server), Go (gopls), Rust (rust-analyzer), Ruby (Solargraph), PHP (Intelephense).

Each language has a Dockerfile in `../../docker/<lang>/`.

## Adding a new LSP server

1. Create `docker/<lang>/Dockerfile` with the language server at ENTRYPOINT (stdio mode)
2. Add entry to `LSP_CONFIGS` in [lsp-configs.ts](lsp-configs.ts):
   - `id`, `languageIds` (matches reverseDoc `Language`), `dockerImage`, `dockerfilePath`
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
- `resolvedBy: "lsp"` field on `SymbolLink` marks LSP-resolved links (vs default `"text"`)
- Individual request failures are swallowed (one bad file shouldn't abort the whole pass)
