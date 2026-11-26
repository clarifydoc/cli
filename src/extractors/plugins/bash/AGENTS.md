# Bash plugin

Reads Bash/sh with tree-sitter (flat tree copy, `FLAT_TREE_LANGUAGES`): `source` shares scope, scripts run by path are `executes` imports, plus `curl` and database-client SQL.

- [manifest.ts](manifest.ts) — dotfile `namedFiles`, shebang admission of extension-less scripts and the `source` scope rule are explained in its comments. A script run by path that is non-relative resolves under the nearest directory, from the importer's up, that holds the path ([imports.ts](imports.ts)).
- [functions.ts](functions.ts), [commands.ts](commands.ts), [data-sources.ts](data-sources.ts), [call-hooks.ts](call-hooks.ts), [reachability.ts](reachability.ts).
- The Bash grammar's lexer has a WebAssembly function body over 150 KB (`BASELINE_ONLY_BODY_BYTES`), so it is compiled to stay on V8's baseline tier (`compileBaselineOnly`), like Swift's and Julia's.
