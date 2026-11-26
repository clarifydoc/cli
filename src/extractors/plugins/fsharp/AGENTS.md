# F# plugin

Reads `.fs`, `.fsi` (signature files) and `.fsx` (scripts) with tree-sitter (`tree-sitter-fsharp`, two grammar variants: `fsharp` and `fsharp_signature` for `.fsi`, picked per file by `keyForFile`; flat-tree copy of the parse). Family `dotnet`; ecosystem `nuget`. Cross-language mechanisms: [../AGENTS.md](../AGENTS.md); the shared .NET pieces are in [../csharp/AGENTS.md](../csharp/AGENTS.md).

## Files and front end

- [manifest.ts](manifest.ts): `importsShareScope: true` — `open Shop.Domain` puts a module or namespace's functions in scope by name, so a bare call resolves to the ONE opened file that declares it. `projectMarkers` `**/*.fsproj` (kind `dotnet`, priority 30). Package managers: NuGet through `.fsproj` and Paket ([package-manifests.ts](package-manifests.ts): `nuget Giraffe ~> 6.0` lines of `paket.dependencies`). Framework hints: Giraffe, Saturn, Falco, Dapper, `Npgsql.FSharp`; external prefixes `System`, `Microsoft.`, `FSharp.`, Giraffe, Saturn, Falco, Dapper, Npgsql. Test files `…Test(s).fs` and anything under `test(s)/`.
- `.fs` is also a GLSL fragment shader's extension: the meta's `preprocess` skips a file with `#version`, `gl_FragColor`/`gl_FragCoord` or `uniform`/`varying`/`precision` lines ("GLSL shader, not F#").
- [syntax.ts](syntax.ts) holds the shared readers over the tree-sitter-fsharp tree; `isFunctionDefinition` keeps `<setup>` out of the `let` functions.

## Structure

[functions-classes.ts](functions-classes.ts):

- Functions are the module-level `let`s of the file, its namespaces and its nested modules — `let f x = …`, and a value that computes something (`let webApp = choose […]`, `let handler = fun next ctx -> …`); a constant (`let port = 8080`) is no function. Calls in local `let`s belong to the enclosing function.
- Types: records (fields become properties), unions, and classes — the primary constructor (`type Svc(repo: IRepo)`) is the class's constructor and its parameters are the injection points; `member`s are methods; `inherit Base(…)` is the base class; `interface IX with` lists an implemented interface. A type with nothing but `abstract` members is an interface.
- Imports ([imports-exports.ts](imports-exports.ts)): `open Shop.Domain`; in a script `#load "helpers.fsx"` loads a file and `#r "nuget: Dapper"` a package.

## Calls

[call-hooks.ts](call-hooks.ts): F# calls are function applications (`repo.Find id`, `json o next ctx`, `ctx.GetService<T>()`). A curried application nests (`f a b` is app(app(f, a), b)): only the innermost names the callee, so an outer one reports nothing. A function piped into or composed with (`x |> save`, `GET >=> handler`; operators `|>`, `||>`, `|||>`, `>=>`, `>>`) is called too; an all-capital name on the right (`GET`) is a combinator, not a call.

## Routes

[routes.ts](routes.ts): Giraffe (`GET >=> route "/x" >=> handler`, `routef "/x/%i" handler`, `choose [ … ]`, `subRoute "/api" (choose [ … ])` — a method combinator applies to everything after it in its `>=>` chain; `%i`/`%s`/`%O` placeholders become `{int}`/`{string}`/`{guid}`); Saturn (`router { get "/x" handler }`) and Falco (`[ get "/x" handler ]`), read only when the file opens Saturn or Falco; ASP.NET Core minimal APIs (`app.MapGet("/x", Func<…>(handler))`). The handler is the function the route ends in, when it is named. The grammar nests applications and `>=>` the other way round, so the reader linearizes the expression and splits at `>=>`.

## Data access

[data-sources.ts](data-sources.ts): SQL in any string literal — Dapper (`conn.QueryAsync<Order>("SELECT …")`), Npgsql.FSharp (`Sql.query "…"`), SqlCommand, a `"""…"""` block, one source per statement (a string with no SQL statement is skipped) — and HttpClient calls with a literal URL (`client.GetAsync("/api/x")`).

## Reachability

[reachability.ts](reachability.ts): a project compiles exactly the files its `.fsproj` lists (`<Compile Include="Domain.fs" />`), so the project file's mentions keep them alive; types and functions are reached by name across the assembly; the program starts at `[<EntryPoint>]` / `Program.fs`. A script (`.fsx`) is run by `dotnet fsi` — kept alive, anchoring nothing.
