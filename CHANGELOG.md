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

- `LICENSE` (MIT), `SECURITY.md` — how to report a vulnerability, and exactly what network access the CLI
  makes — and this changelog.

### Changed

- The report template's error messages no longer refer to a build script this package does not have.
