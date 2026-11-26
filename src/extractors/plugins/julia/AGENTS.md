# Julia plugin

Reads Julia with tree-sitter (flat tree copy, `FLAT_TREE_LANGUAGES`): Genie, Oxygen and HTTP.jl routes. `include` shares scope. Package file: `Project.toml`.

- `include` puts the included file's functions in scope without naming them (`importsShareScope`): a bare call the file does not define links to the ONE included file that does (`import-file`).
- The grammar's lexer has a WebAssembly function body over 150 KB (`BASELINE_ONLY_BODY_BYTES`), so it is compiled to stay on V8's baseline tier (`compileBaselineOnly`), like Swift's and Bash's.
- Dead code: a declarative reachability spec of the shared kit.
