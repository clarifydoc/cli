# src/mcp — Model Context Protocol server

Serves the analysis to AI agents. Started by `clarifydoc mcp` (see [src/cli.ts](../cli.ts)) and by the VS Code
extension, which publishes the same command as an MCP server definition (the extension's `src/mcp.ts`).

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
| [tools/](tools/) | The tools themselves — `context.ts` (shared: `freshnessBanner`, `resolveSymbolArg`), `overview.ts` (status, search), `code.ts` (routes, contract, screens, file, trace (callers, callees, overrides; `writers` and `readers` answer from `member-effects.ts`), blast), `rename-plan.ts`, `extract.ts`, `data.ts`, `decisions.ts` (+ [decisions-api.ts](decisions-api.ts), exported from the package index), `commands.ts` (CLI commands as tools: `seq`, `diff`, `export`, `facts`), `caller-bounds.ts` |
| [http.ts](http.ts) | The Streamable HTTP transport (`serveHttp`): sessions, SSE streams, loopback and token rules |
| [body-search.ts](body-search.ts), [search-rank.ts](search-rank.ts) | `clarifydoc_search`'s BM25 body index and its cross-kind ranking |
| [paging.ts](paging.ts), [budget.test.ts](budget.test.ts), [hidden-tools.ts](hidden-tools.ts), [usage.ts](usage.ts) | Offset cursors and the output cut, the up-front size budget, `--tools core` rewrites, the session usage line |
| [impact-worktree.ts](impact-worktree.ts) | `clarifydoc_impact worktree=`: another checkout of the analyzed repository |

Per-tool behaviour (rename plan refusals, extract's class signatures and inline-route definitions, context docs, the CLI-command tools, caller bounds, body search) is in the doc comment at the top of each tool's file.

## Rules that keep it working

- **Stdout is the wire.** Only JSON-RPC frames may reach stdout. `startMcpServer` pins `console.log/info/debug` to
  stderr for the session, and `AnalysisStore.refresh` does the same around an analysis run (the analyzer and its
  plugins log freely). Anything diagnostic goes through the `log` sink → stderr.
- **Two transports, one server.** `serveStdio` reads newline-delimited JSON or `Content-Length: N` frames, decided per
  message by `FrameReader` (bytes, so split chunks and multi-byte text are safe) and answers in the framing each
  message used. [http.ts](http.ts) `serveHttp` (`clarifydoc mcp --http`) is the Streamable HTTP subset over the same
  `McpServer`; its sessions, streams, `listChanged` notifications, loopback-only default and bearer-token rules are in
  its header comment. Keep any new transport behaviour identical between the two.
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
- **Every answer says when it is stale.** `McpServerOptions.annotate` ends each tool's text with `freshnessBanner`
  ([tools/context.ts](tools/context.ts), whose comment holds what counts as changed, the commit relation, the
  `engine-older` rule, per-file `⚠` lines and the `post-git` hook that keeps it current) while the analysis no longer
  describes the source. One stat pass per ten seconds, however many calls; `clarifydoc_status` and `clarifydoc_analyze`
  are left alone.
- **An overload is named by its types.** A symbol's id may end in its parameter types (`Squad.Pick(int)`); every tool matches a typed argument to the one and an untyped name to all of them through `symbolAnswersTo` ([../core/owner-paths.ts](../core/owner-paths.ts)), and a name with several definitions lists them by their typed ids.
- **Lookups forgive a spelling.** A symbol argument of `extract`, `trace`, `explain` and `rename_plan` goes through
  `resolveSymbolArg`; a file path that matches nothing offers up to three `nearFiles`. `clarifydoc_search` flags matched
  definitions in generated files (`markGenerated`) and ranks them after shipped ones at equal score, as tests rank;
  `clarifydoc_explain` of a class adds "Calls out of the class" (`classOutCalls`).
- **Body search is opt-in.** `clarifydoc_search body=true` (or `throws=`) builds a BM25 index once per loaded analysis,
  in memory ([body-search.ts](body-search.ts) says what it indexes and how doc and signature tiers rank). The
  tools/list byte budget is tight: new schema text has to pay for itself.
- **A symbol or file hit carries a `reached from:` line** — up to three routes/screens of its file's blast-radius `traceImpact`, `(+N)` for the rest; computed in `reachSuffix` only for the hits a page shows, after ranking, so it never changes order (asserted in search-reach.test.ts). File granularity: a lower bound.
- **Search ranks across kinds, not within them.** `clarifydoc_search` flattens every source into one
  `Candidate` list ([search-rank.ts](search-rank.ts)) and prints one ranked list, because whatever prints first
  IS the rank — for a model reading top-down and for a search benchmark alike. A new searchable kind
  contributes `Candidate`s; it must not print a section of its own. The tiers and tie-breaks are tuned against
  hand-labelled queries on real repositories, never against the tool's own output, and every one of them is pinned by a case in `search-rank.test.ts`.
- **"No callers" is a lower bound, and says why.** A symbol, file or route nothing resolved to never reads as safe to
  delete ([tools/caller-bounds.ts](tools/caller-bounds.ts) holds what it counts); a failed `trace to=` names the node its
  forward walk got nearest to the target.
- **`clarifydoc_impact` and `clarifydoc_blast_radius` charge by member.** With the diff's lines (git, `proposed`) impact's dependents are the files naming what changed, the importer count printed beside it (core/AGENTS.md); `clarifydoc_blast_radius` takes `members` (`Class.method`, a function or a type) and `adding` for the same cut, and without them ranks direct dependents by how much of the file they use, so the default limit of 20 keeps users before bare importers.
- **`clarifydoc_impact` can read another checkout.** `worktree=<path>` (or the server's `CLARIFYDOC_WORKTREE`; the
  working directory is never guessed) points at a linked worktree of the analyzed repository; [impact-worktree.ts](impact-worktree.ts)
  requires both to share one `--git-common-dir` and refuses anything else.
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
  [guidance.ts](guidance.ts), which only the AGENTS.md / CLAUDE.md section carries.
  `CLARIFYDOC_MCP_LOG=<file>` logs each call locally (JSONL; `sectionBytes` in protocol.ts;
  `node scripts/mcp-log-summary.mjs <log>` summarizes) and `clarifydoc://session/usage` renders the session's calls
  ([usage.ts](usage.ts)). `--tools core` rewrites mentions of a hidden tool to `clarifydoc ask <tool> key=value`
  ([hidden-tools.ts](hidden-tools.ts)); `ALWAYS_LOAD` (search, trace) is in `server.ts`.
- **No call outlives the client's deadline.** An analysis a call waits for — `clarifydoc_analyze`, a cold
  start, or the base ref `clarifydoc_diff` analyzes (`AnalysisStore.waitWithin`) — gets `waitMs` (20 s, `CLARIFYDOC_MCP_WAIT_MS`); past it the call answers that the run is still going,
  with its stage and file count (`describeRun`, read off the analyzer's own progress line), and the run goes on.
  The next call joins that run (`AnalysisStore.running`), never a second one. A request carrying `_meta.progressToken`
  gets `notifications/progress` each second meanwhile (`ToolExtras.progress`, sent by the stdio transport).
- **One writer per analysis directory.** The CLI, the extension and a cold start share `.clarifydoc/`, so
  `analyze()` holds an advisory lock ([../core/analysis-lock.ts](../core/analysis-lock.ts)). A store that finds the
  lock held waits for the other run's summary instead of starting a competing scan; the lock heartbeats, so a long
  analysis is never stolen, and a crashed one is.

- **No analysis behind the server.** When the output directory is missing, unreadable or holds a summary that is not valid JSON, every tool answers — never throws past the protocol layer — with the path and the command that writes the analysis (`AnalysisStore.analyzeCommand`, `unreadableMessage`).

## Adding a tool

1. Write it in the matching `tools/*.ts` as a `McpTool` factory taking `ToolContext`.
2. Register it in the `tools` array in [server.ts](server.ts) (order is the order clients list them in).
3. Extend `tools.test.ts` — derive expectations from the loaded fixture summary rather than hardcoding names, so
   regenerating `test-output/` cannot make the test lie. If the tool can come back empty, add it to the
   `points at another tool when it has nothing to show` table with arguments that cannot match.

Describe the tool in terms of the *question it answers*; the description is the only thing a model reads before
choosing it.

A route whose handler is written inline is a definition every symbol tool reads: `inlineRouteDefinitions` ([core/route-symbol.ts](../core/route-symbol.ts)); see [tools/extract.ts](tools/extract.ts).
