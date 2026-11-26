# PowerShell plugin

Reads PowerShell with regex patterns: Pode and Polaris routes, `Invoke-RestMethod`, SQL in strings and here-strings, PowerShell Gallery `RequiredModules`.

- [index.ts](index.ts) — commands are its only calls, so its patterns set `replacesBaseline` and the generic `name(` matcher is off (`Write-Output (Get-Date)` is no call of `Output`).
- Dot-sourcing puts the sourced file's functions in scope without naming them (`importsShareScope`): a bare call the file does not define links to the ONE sourced file that does (`import-file`). A script PowerShell RUNS is an import with `executes: true` and shares nothing; a non-relative one resolves under the nearest directory, from the importer's up, that holds the path.
- [routes.ts](routes.ts), [data-sources.ts](data-sources.ts), [source.ts](source.ts), [package-manifests.ts](package-manifests.ts). Dead code: a declarative reachability spec of the shared kit.
