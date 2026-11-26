# Zig plugin

Reads `.zig` with a tree-sitter grammar (`parsing: "tree-sitter"`, `@tree-sitter-grammars/tree-sitter-zig`; Zig is one of the languages read through the flat tree copy — see [parsers/AGENTS.md](../../../parsers/AGENTS.md)). Family `zig`; activation files `build.zig`, `build.zig.zon`; test files `test/`/`tests/` `*.zig`. Framework hints: `zap`, `httpz`, `jetzig`, `tokamak` (distinctive names only: `pg` is also node-postgres).

## Files

- [functions-classes.ts](functions-classes.ts) — functions, struct/enum/union types, a file as a struct, struct-literal local types; [syntax.ts](syntax.ts) — `pub`/`export` tokens.
- [call-hooks.ts](call-hooks.ts) — calls and scopes; [imports-exports.ts](imports-exports.ts) — `@import` files and packages, `pub` exports.
- [routes.ts](routes.ts) — http.zig, zap, tokamak, jetzig; [data-sources.ts](data-sources.ts) — SQL strings and `std.http.Client`.
- [reachability.ts](reachability.ts) — dead code from `@import` paths and what `build.zig` names; [package-manifests.ts](package-manifests.ts) — `build.zig.zon`; [test-command.ts](test-command.ts) — `zig build test` or per-file filters.
- `meta.ts` / `manifest.ts` wire these into the registry.
