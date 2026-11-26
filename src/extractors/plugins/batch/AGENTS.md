# Batch plugin

Reads Windows batch (`.bat`, `.cmd`) with regex patterns: labels are functions.

- Doc comments: the manifest's `docComments` sets `caseInsensitive` so `REM` matches in any case.
- Invocations of other scripts are imports with `executes: true`: they share nothing; a non-relative one resolves under the nearest directory, from the importer's up, that holds the path.
- Dead code: a declarative reachability spec of the shared kit.
