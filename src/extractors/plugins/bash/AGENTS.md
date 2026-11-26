# Bash plugin

Reads Bash/sh with tree-sitter (flat tree copy, `FLAT_TREE_LANGUAGES`): `source` shares scope, scripts run by path are `executes` imports, plus `curl` and database-client SQL.

## Files

- `namedFiles` may start with `.` (`.bashrc` / `.zshrc` / `.profile` / `.bash_profile`): discovery globs `**/.bashrc` with `dot` still false, so only those basenames are admitted, not every hidden file. `resolveTarget` / `resolveImportSource` match such a path as written before the leading-dot relative-module rewrite.
- Extension-less scripts are admitted by their first line: a regular, unlinked, non-dotfile in the root or a `bin/`, `script/` or `scripts/` directory at any depth whose `#!` line names a Bash/sh interpreter (`shebangInterpreter`, read through `env` and its flags) is a Bash file.

## Imports

- `source` puts the sourced file's functions in scope without naming them (`importsShareScope`): a bare call the file does not define links to the ONE sourced file that does (`import-file`).
- A script run by path is an import with `executes: true` and shares nothing; a non-relative one resolves under the nearest directory, from the importer's up, that holds the path.

## Parser

- The Bash grammar's lexer has a WebAssembly function body over 150 KB (`BASELINE_ONLY_BODY_BYTES`), so it is compiled to stay on V8's baseline tier (`compileBaselineOnly`), like Swift's and Julia's.
