# F# plugin

Reads `.fs`, `.fsi` (signature files) and `.fsx` (scripts) with tree-sitter (`tree-sitter-fsharp`, two grammar variants: `fsharp` and `fsharp_signature` for `.fsi`, picked per file by `keyForFile`; flat-tree copy of the parse). Family `dotnet`; ecosystem `nuget`. Cross-language mechanisms: [../AGENTS.md](../AGENTS.md); the shared .NET pieces are in [../csharp/AGENTS.md](../csharp/AGENTS.md).

## File map

- [manifest.ts](manifest.ts) — static tier (`importsShareScope`, `.fsproj` markers, packages, framework hints, test files). [meta.ts](meta.ts) — runtime tier; its `preprocess` skips GLSL shaders that share `.fs`.
- [syntax.ts](syntax.ts) — shared readers over the tree; `isFunctionDefinition` keeps `<setup>` out of the `let` functions.
- [functions-classes.ts](functions-classes.ts) (module-level `let`s, records/unions/classes), [imports-exports.ts](imports-exports.ts) (`open`, `#load`, `#r`), [call-hooks.ts](call-hooks.ts) (curried applications, `|>`/`>=>`), [routes.ts](routes.ts) (Giraffe, Saturn, Falco, minimal APIs), [data-sources.ts](data-sources.ts) (SQL strings, HttpClient), [package-manifests.ts](package-manifests.ts) (NuGet, Paket), [reachability.ts](reachability.ts) (`.fsproj` compile lists).

Each file's header comment holds its rules.

## Rules

- Plugins report facts; core resolves. F# calls are applications, so only the innermost of a curried application names the callee.
- `.fsx` scripts are kept alive and anchor nothing in reachability.
