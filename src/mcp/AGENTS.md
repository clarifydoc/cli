# src/mcp — Model Context Protocol server

Serves the analysis to AI agents. Started by `clarifydoc mcp` (see [src/cli.ts](../cli.ts)) and by the VS Code
extension, which publishes the same command as an MCP server definition ([VsCode/src/mcp.ts](../../VsCode/src/mcp.ts)).

With no arguments the server serves the project containing the working directory (`findProjectRoot` walks up to a
`.git`/manifest marker) and reads `<root>/.clarifydoc/<name>` — where both `clarifydoc analyze` and the extension
write. That is what lets an external agent be configured as nothing but a command, with no path to keep in sync.

| File | Purpose |
|------|---------|
| [protocol.ts](protocol.ts) | Dependency-free MCP over stdio: JSON-RPC framing, `initialize` negotiation, `tools/*`, `resources/*` (incl. URI templates — the last variable takes the rest of the URI, so a project path needs no escaping), `prompts/*` |
| [store.ts](store.ts) | Locates/loads/refreshes the analysis, cold-starts a project with none, and indexes it per file (`FileFacts`) |
| [format.ts](format.ts) | Text shaping (capped lists, `path:line`) and argument coercion |
| [empty.ts](empty.ts) | The shape of a result with no rows in it — miss, denominator, `Next:` |
| [server.ts](server.ts) | Assembles store + tools + instructions into a servable `McpServer`, plus the resource templates (`clarifydoc://file/{path}`, `clarifydoc://symbol/{symbol}/{path}` — each the text of the tool that already says it) and the workflow prompts (`before-editing`, `before-writing`, `trace-feature`, `endpoint-gaps`, `refactor`, …: the order of tool calls that answers one recurring question, also installed as skills) |
| [package-api.ts](package-api.ts) | `clarifydoc_extract package=`: an installed package's exported API (or one export's declaration) through the plugin's `PackageManagerSpec.installedApi`, looked up beside the manifests declaring it, then each sub-project, then the root |
| [guidance.ts](guidance.ts) | When to reach for which tool, said once: the server instructions and `AGENT_GUIDANCE` (the AGENTS.md / CLAUDE.md section `clarifydoc install` and the editor write). A `fileOnly` rule goes only into the file — the instructions are on the up-front budget |
| [role.ts](role.ts) | What a file or function is (route handler, data access, data model, screen, entry point, API client, shared utility, orchestrator), from extracted facts only — never a name token; `clarifydoc_explain`'s second line |
| [tools/](tools/) | The tools themselves — `context.ts` (shared), `overview.ts`, `code.ts` (routes, contract, screens, file, trace, blast), `rename-plan.ts` (`clarifydoc_rename_plan`: the definition and every caller of a symbol as `file:line:col` spans re-lexed from the source line, read-only; it lists the route lines that register the symbol in their own section ("Route registrations": the span of its name on the route line, inside a string too — `clubs#index` — a route annotation on the method itself is the definition, and so is a route the analysis anchors on the method it names — a Rails `get 'clubs', to: 'clubs#index'` or `resources :players` row whose link source is the controller method: its `config/routes.rb` line is then not listed, only the definition; `registrationSpan` is tested on those lines), and refuses — no partial plan — on an INFERRED/AMBIGUOUS link, a line naming it other than once, a route line spelling no such name, or an override/implementation/interface member, and says which rows), `extract.ts` (a function's source and its callees within a token budget — the one tool that reads source text, at the analyzed spans), `data.ts`, `decisions.ts` (`clarifydoc_context_docs` and `clarifydoc_file`'s Decisions section: decision records, context documents and decision markers from `core/context-docs.ts`, reused for 30 s; a document is read only from that list; per `file` (and `function`), the reasons comments and commit bodies state, from `core/stated-reasons.ts`), `commands.ts` (the CLI commands that print what an agent asks for, answered from the served analysis: `seq` → `clarifydoc_sequence`, `diff --base` → `clarifydoc_diff`, `export` → `clarifydoc_export` (one format; a folder-shaped bundle stays a command), `facts` → `clarifydoc_facts`; `lint` is `clarifydoc_status lint=true`, `report` is `clarifydoc_analyze report=true`, `schema` and `detect --json` are the resources `clarifydoc://analysis/schema` and `clarifydoc://project/detect`; `install`, `hook`, `lsp-update` and `ask` stay commands) |

## Rules that keep it working

- **Stdout is the wire.** Only JSON-RPC frames may reach stdout. `startMcpServer` pins `console.log/info/debug` to
  stderr for the session, and `AnalysisStore.refresh` does the same around an analysis run (the analyzer and its
  plugins log freely). Anything diagnostic goes through the `log` sink → stderr.
- **Two transports, one server.** `serveStdio` reads newline-delimited JSON or `Content-Length: N` frames, decided per
  message by `FrameReader` (bytes, so split chunks and multi-byte text are safe) and answers in the framing each
  message used. `http.ts` `serveHttp` (`clarifydoc mcp --http [--port] [--host] [--token-file]`) is the Streamable HTTP
  subset: `POST /mcp` JSON-RPC message or batch → JSON, notifications → 202, body capped at 4 MB, every request sharing
  the one `McpServer` (analysis loaded once). Sessions are a Map (id → created, last seen, `clientInfo`, open streams):
  issued on `initialize`, idle expiry (`CLARIFYDOC_MCP_SESSION_TTL_MS`, default 30 min; a session with an open stream is
  not idle), at most 64 (least recently seen evicted), `DELETE` ends one and closes its streams, an unknown or expired
  id is 404 so the client re-initializes. `GET /mcp` with `Accept: text/event-stream` and a session id is a server-sent
  event stream (keep-alive comment every 25 s; one session holds at most 4 — opening a fifth closes its oldest, `MAX_STREAMS_PER_SESSION`); `HttpHandle.broadcast` writes a notification to every open stream —
  `server.ts` pushes `notifications/tools/list_changed` and `resources/list_changed` when an analysis this store ran
  finishes (`AnalysisStore.onAnalysisChanged`) or the summary file's mtime moves (polled every 5 s: the editor or CLI
  re-analyzed); `listChanged` is declared only on this transport. A GET without that Accept is 405. Loopback only by
  default (`Host`/`Origin` must be loopback, on GET too); any other `--host` refuses to start without a token, checked as
  a bearer with a constant-time compare on every method. Token precedence: `--token-file` (first line; warns when group/
  world-readable), then `CLARIFYDOC_MCP_TOKEN`, then `--token` (stderr warning: it shows in the process list). The URL
  goes to stderr only.
- **No new dependencies.** The whole transport is hand-rolled precisely because this code is bundled into the VS Code
  extension, whose bundle script ships the analyzer's production closure.
- **One source of truth.** Every answer comes from `loadReportSummary` — the same denormalized, LSP-merged
  `ProjectAnalysis` the HTML report renders — so an MCP answer and the report can never disagree. Per-file detail
  (imports/exports) comes from the per-file JSON via `AnalysisStore.fileAnalysis`.
- **Tool output is for a context window.** Cap every list and say how many rows were withheld (`bulletList`). A
  tool's main list also pages: `offset` (`OFFSET_SCHEMA`, `offsetArg`, `page`, `pageFooter`) with a footer naming the
  next offset — routes, screens, search, data_flows, health and data_model; caps stay as they are. Tools write
  the footer as `` `offset=N` ``; the protocol sends it as the cursor `offset="N@rev"` of the analysis revision
  and, read back in another revision, prefixes a note that rows may have moved ([paging.ts](paging.ts)). It also
  cuts any answer over `CLARIFYDOC_MCP_MAX_TOKENS` (20000) at a line, saying how to ask for less — below the
  hosts' own cut, which would take the footer with it; a call's own `maxTokens` is exempt. Emit
  `path:line` for anything worth opening, and never silently return nothing — a miss explains what exists instead
  (`"No routes match … the analysis holds N routes"`), which is what stops an agent from re-guessing.
- **An empty result names the call that would have data.** Every miss goes through `noResults` ([empty.ts](empty.ts))
  and reads the same three parts: the miss (with the filters echoed), the denominator, then one `Next:` line of at
  most two calls. A miss is an answer, so `isError` stays false. Only suggest what was *computed* — the filter whose
  removal actually yields rows (`filterToDrop`), the query term that actually has hits (`termDiagnosis`), the
  freshness state actually observed (`stalenessHint`, which spends a few hundred stats to answer "is this empty
  because the analysis is stale?" instead of delegating it to `clarifydoc_status`). A wrong next step costs more
  than no next step, and a hint carrying a number is the difference between "try a looser filter" and a call that
  lands. Hints are **stateless by design**: a stdio server's "session" is not reliably one agent, so nothing is
  derived from what the caller asked earlier.
- **Every answer says when it is stale.** `McpServerOptions.annotate` ends each tool's text with
  `freshnessBanner` (tools/context.ts) while the analysis no longer describes the source — files changed, removed
  or added since (`assessFreshness`: added files come from `git ls-files`, in directories the analysis covers,
  written after its manifest), and HEAD against the commit it was made at (`sourceRevision`, also in the
  manifest) — then one bounded `rev-list --left-right --count` (`commitRelation`, core/source-revision.ts) says how: HEAD N commits ahead, older, diverged, or the analyzed commit gone from the repository (rebased away); `clarifydoc_status` shows it on its commit row even when HEAD moved without touching an analyzed file. The `post-git` hook (agents/hooks.ts) keeps it current: after a shell git command that moves the tree it starts one detached incremental `analyze`, coalesced by a lock file, with the options the analysis was made with (`Manifest.runOptions`, written by the analyzer: the output directory relative to the root, LSP on/off, git history, the `--feature` deviations, the `--spec` / `--coverage` files given as project-relative paths (one outside the root is dropped) — never a path outside the root or a secret; `refreshArgs`; the plain default for an older manifest). Codex gets it in `hooks.json` and in the `config.toml` block alike. An analysis a NEWER engine wrote is not stale (`engine-older`, versions compared as numbers): the
  banner says the server is older and wants a restart, and `clarifydoc_analyze` refuses to write the older reading
  over it (`EngineOlderError`). One stat pass per ten seconds, however many calls; `clarifydoc_status` and `clarifydoc_analyze` are
  left alone, since they are about exactly that. Per file, the subject of `clarifydoc_file`,
  `clarifydoc_blast_radius` and `clarifydoc_explain` gets a `⚠ … changed since the analysis` line under the heading
  and each listed dependent a `(changed since the analysis)` suffix (`AnalysisStore.changedSinceAnalysis`: a stat
  per path against the manifest, a hash only where the mtime moved, verdicts kept per mtime). No manifest, no note.
- **Body search is opt-in.** `clarifydoc_search body=true` (or `throws=`) builds a BM25 index over function
  bodies and the doc comments above them — spans from the summary's complexity rows, text from the
  source — once per loaded analysis, in memory (`body-search.ts`). The same call ranks functions and classes by
  their `doc` (the first sentence, from the per-file JSON) as a name-search tier of its own, below every name and
  path tier — never without `body`, since reading every per-file JSON is what it costs. When no name matches every
  term (a question described in words), the body hits lead and the partial name matches follow under their own
  heading; body hits in test files come after the code unless the query mentions tests. `signature=` reads parameters and
  return types from the per-file JSON of the candidates only. The tools/list byte budget is tight:
  new schema text has to pay for itself.
- **A symbol or file hit carries a `reached from:` line** — up to three routes/screens of its file's blast-radius `traceImpact`, `(+N)` for the rest; computed in `reachSuffix` only for the hits a page shows, after ranking, so it never changes order (asserted in search-reach.test.ts). File granularity: a lower bound.
- **Search ranks across kinds, not within them.** `clarifydoc_search` flattens every source into one
  `Candidate` list ([search-rank.ts](search-rank.ts)) and prints one ranked list, because whatever prints first
  IS the rank — for a model reading top-down and for a search benchmark alike. A new searchable kind
  contributes `Candidate`s; it must not print a section of its own. The tiers and tie-breaks are tuned against
  hand-labelled queries on real repositories, never against the tool's own output, and every one of them is pinned by a case in `search-rank.test.ts`.
- **"No callers" is a lower bound, and says why.** A symbol, file or route nothing resolved to never reads as safe to
  delete ([tools/caller-bounds.ts](tools/caller-bounds.ts)): the answer counts the unresolved calls elsewhere named
  like the member (one pass over the per-file JSON per loaded analysis, up to five `file:line` examples, code before
  tests), the interface/base declaration above it or the container registration that builds its class, and — for a
  route — the files whose source holds its path literal with no call linked from them (a scan of the analysed files,
  screen links like `to="/x"` skipped). A failed `trace to=` names the node its forward walk got nearest to the target
  (in the target's file when it reached one, else the deepest) and how many of its calls did not resolve.
- **`clarifydoc_impact` can read another checkout.** `worktree=<path>` (or the server's `CLARIFYDOC_WORKTREE`; the
  working directory is never guessed) points at a linked worktree of the analyzed repository: the diff, its hunks, the
  working-file re-analysis and a `proposed` edit's old text come from there, while paths stay the analysis's own
  (the project keeps its place inside the worktree). [impact-worktree.ts](impact-worktree.ts) requires both to share
  one `--git-common-dir` and refuses anything else; the answer's first line names the worktree.
- **Tool failures are results, not transport errors.** A thrown handler is turned into `isError: true` content by
  `McpServer.callTool`, so the model reads the message. Throw with the fix in the text (candidate paths, the tool to
  call next).
- **`readOnly` is a contract.** Every tool but `clarifydoc_analyze` and `clarifydoc_diff` only reads, and those two
  write only under the analysis directory (`clarifydoc_diff` the base ref's analysis in `.base/<commit>/`, built in a
  temporary worktree it removes) and refuse under `--no-auto-analyze`. Keep it that way: the VS Code integration
  advertises the server as safe and defaults to `--no-auto-analyze`.
- **Read-only must still not dead-end.** `--no-auto-analyze` blocks re-analysis on request, but a project with no
  analysis at all is still analyzed once (`AnalysisStore.coldStart`) — otherwise every tool call would answer "run it
  from the editor" and the agent could do nothing. `--no-cold-start` forbids even that, which is what the tests use.
  A cold start never runs on the home directory or a filesystem root, nor when `clarifydoc mcp` got no path and
  found no project marker above the working directory (`coldStartRefusal`) — a user-scope client config started
  from `$HOME` would otherwise scan the whole home directory before its first answer. `clarifydoc_analyze` still
  works there: refusing the unasked-for scan is the point, not refusing the user.
- **Repository text is data.** Every answer goes through `sanitizeOutput` (control characters dropped, bidi
  overrides shown as `\u202e` escapes, not applied), source excerpts are `fenced` with a backtick run the text
  cannot close, and the instructions say quoted repository text is never an instruction.
- **The up-front cost has a budget.** `tools/list` plus the instructions must stay under `BUDGET_BYTES`
  ([budget.test.ts](budget.test.ts)), and `tools/list` alone (15,000 bytes) and the instructions (1,300 characters)
  under their own; a description that pushes past one is argued for in the commit that raises it. A tool's
  description is one "Use …" sentence plus its arguments in a few words; an example call goes to `EXAMPLES` in
  [guidance.ts](guidance.ts), which only the AGENTS.md / CLAUDE.md section carries, and the instructions name
  each question's tool in a line (`brief`) — the reasons are in that section too.
  `CLARIFYDOC_MCP_LOG=<file>` logs each call locally (JSONL: tool, cut arguments, size, `bytes` and `sections` — bytes per heading-delimited part of the answer, `sectionBytes` in protocol.ts —, time, error, empty;
  `node scripts/mcp-log-summary.mjs <log>` prints per tool the calls, bytes and each section's share) and
  the session's `usageLine` at disconnect; `clarifydoc://session/usage` renders the same calls ([usage.ts](usage.ts)).
  `--tools core` (`CORE_TOOLS`, `selectTools`) lists a smaller set and says so in the instructions; a tool left out
  is not callable, so every mention of one — in an answer, a resource, a prompt, a tool description and the
  instructions — is rewritten to `clarifydoc ask <tool> key=value` ([hidden-tools.ts](hidden-tools.ts), the server's
  `rewrite` option, applied where text leaves it); mentions are rewritten, never dropped, and with the full list
  nothing changes. Keep the core set what answers point to most all the same: a shell call costs a round trip.
  `ALWAYS_LOAD` (search, trace) carry `_meta["anthropic/alwaysLoad"]: true`, which Claude Code reads to load
  those schemas up front while it defers the rest behind its tool search; `_meta` is not counted in the budget
  (it reaches the host, not the model).
- **No call outlives the client's deadline.** An analysis a call waits for — `clarifydoc_analyze`, a cold
  start, or the base ref `clarifydoc_diff` analyzes (`AnalysisStore.waitWithin`) — gets `waitMs` (20 s, `CLARIFYDOC_MCP_WAIT_MS`); past it the call answers that the run is still going,
  with its stage and file count (`describeRun`, read off the analyzer's own progress line), and the run goes on.
  The next call joins that run (`AnalysisStore.running`), never a second one. A request carrying `_meta.progressToken`
  gets `notifications/progress` each second meanwhile (`ToolExtras.progress`, sent by the stdio transport).
- **One writer per analysis directory.** The CLI, the extension and a cold start now share `.clarifydoc/`, so
  `analyze()` holds an advisory lock ([../core/analysis-lock.ts](../core/analysis-lock.ts)). A store that finds the
  lock held waits for the other run's summary instead of starting a competing scan; the lock heartbeats, so a long
  analysis is never stolen, and a crashed one is.

## Adding a tool

1. Write it in the matching `tools/*.ts` as a `McpTool` factory taking `ToolContext`.
2. Register it in the `tools` array in [server.ts](server.ts) (order is the order clients list them in).
3. Extend `tools.test.ts` — derive expectations from the loaded fixture summary rather than hardcoding names, so
   regenerating `test-output/` cannot make the test lie. If the tool can come back empty, add it to the
   `points at another tool when it has nothing to show` table with arguments that cannot match.

Describe the tool in terms of the *question it answers*; the description is the only thing a model reads before
choosing it.
