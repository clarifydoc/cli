# src/mcp — Model Context Protocol server

Serves the analysis to AI agents. Started by `clarifydoc mcp` (see [src/cli.ts](../cli.ts)) and by the VS Code
extension, which publishes the same command as an MCP server definition ([VsCode/src/mcp.ts](../../VsCode/src/mcp.ts)).

With no arguments the server serves the project containing the working directory (`findProjectRoot` walks up to a
`.git`/manifest marker) and reads `<root>/.clarifydoc/<name>` — where both `clarifydoc analyze` and the extension
write. That is what lets an external agent be configured as nothing but a command, with no path to keep in sync.

| File | Purpose |
|------|---------|
| [protocol.ts](protocol.ts) | Dependency-free MCP over stdio: JSON-RPC framing, `initialize` negotiation, `tools/*`, `resources/*` |
| [store.ts](store.ts) | Locates/loads/refreshes the analysis, cold-starts a project with none, and indexes it per file (`FileFacts`) |
| [format.ts](format.ts) | Text shaping (capped lists, `path:line`) and argument coercion |
| [server.ts](server.ts) | Assembles store + tools + instructions into a servable `McpServer` |
| [tools/](tools/) | The tools themselves — `context.ts` (shared), `overview.ts`, `code.ts`, `data.ts` |

## Rules that keep it working

- **Stdout is the wire.** Only JSON-RPC frames may reach stdout. `startMcpServer` pins `console.log/info/debug` to
  stderr for the session, and `AnalysisStore.refresh` does the same around an analysis run (the analyzer and its
  plugins log freely). Anything diagnostic goes through the `log` sink → stderr.
- **No new dependencies.** The whole transport is hand-rolled precisely because this code is bundled into the VS Code
  extension, whose bundle script ships the analyzer's production closure.
- **One source of truth.** Every answer comes from `loadReportSummary` — the same denormalized, LSP-merged
  `ProjectAnalysis` the HTML report renders — so an MCP answer and the report can never disagree. Per-file detail
  (imports/exports) comes from the per-file JSON via `AnalysisStore.fileAnalysis`.
- **Tool output is for a context window.** Cap every list and say how many rows were withheld (`bulletList`), emit
  `path:line` for anything worth opening, and never silently return nothing — a miss explains what exists instead
  (`"No routes match … the analysis holds N routes"`), which is what stops an agent from re-guessing.
- **Tool failures are results, not transport errors.** A thrown handler is turned into `isError: true` content by
  `McpServer.callTool`, so the model reads the message. Throw with the fix in the text (candidate paths, the tool to
  call next).
- **`readOnly` is a contract.** Every tool but `clarifydoc_analyze` only reads. Keep it that way: the VS Code
  integration advertises the server as safe and defaults to `--no-auto-analyze`.
- **Read-only must still not dead-end.** `--no-auto-analyze` blocks re-analysis on request, but a project with no
  analysis at all is still analyzed once (`AnalysisStore.coldStart`) — otherwise every tool call would answer "run it
  from the editor" and the agent could do nothing. `--no-cold-start` forbids even that, which is what the tests use.
- **One writer per analysis directory.** The CLI, the extension and a cold start now share `.clarifydoc/`, so
  `analyze()` holds an advisory lock ([../core/analysis-lock.ts](../core/analysis-lock.ts)). A store that finds the
  lock held waits for the other run's summary instead of starting a competing scan; the lock heartbeats, so a long
  analysis is never stolen, and a crashed one is.

## Adding a tool

1. Write it in the matching `tools/*.ts` as a `McpTool` factory taking `ToolContext`.
2. Register it in the `tools` array in [server.ts](server.ts) (order is the order clients list them in).
3. Extend `tools.test.ts` — derive expectations from the loaded fixture summary rather than hardcoding names, so
   regenerating `test-output/` cannot make the test lie.

Describe the tool in terms of the *question it answers*; the description is the only thing a model reads before
choosing it.
