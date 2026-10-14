# Changelog

User-facing changes to the `clarifydoc` CLI, its MCP server and its library exports. Earlier versions are
recorded in the git history only.

## Unreleased

### Removed

- The benchmark scoring helpers are no longer exported from the package (`scoreSet`, `rankOf`,
  `meanReciprocalRank`, `scoreTokens`, `estimateTokens`, `mean`, `poolSetScores`, `scoreSampledLinks`,
  `computeCorpusMetrics`, `linkRecords`, `diffCorpusLinks`, `isJoinableTarget`, `startsWithHole` and their
  types). They were never part of the analyzer.

### Added

- The MCP server rejects arguments a tool does not take, and enum values that match nothing, naming the
  nearest valid spelling (`paths` → did you mean `path`?). Both used to be read as "no filter", so a
  misspelt filter returned every row. Lenient spellings that already worked (`"20"` for a number, `API`
  for `api`, a comma list for an array) still do.
- The MCP server no longer analyzes a folder unasked when it is the home directory, a filesystem root, or —
  started without a path — a directory with no project marker above it. It says why and how to point it
  at the project; `clarifydoc_analyze` still works there.
- `clarifydoc report --editor-scheme <scheme>`: file links in the report open in that editor (`cursor`,
  `windsurf`, `vscodium`, …) instead of VS Code.
- `LICENSE` (MIT), `SECURITY.md` — how to report a vulnerability, and exactly what network access the CLI
  makes — and this changelog.

### Changed

- `clarifydoc schema` prints every field of the per-file JSON and of `project-summary.json`, required and
  optional, generated from the types so it can no longer fall behind. It used to print a hand-kept list of
  twelve.
- The report template's error messages no longer refer to a build script this package does not have.
