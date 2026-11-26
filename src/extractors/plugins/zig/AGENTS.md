# Zig plugin

Reads `.zig` with a tree-sitter grammar (`parsing: "tree-sitter"`, `@tree-sitter-grammars/tree-sitter-zig`; Zig is one of the languages read through the flat tree copy — see [parsers/AGENTS.md](../../../parsers/AGENTS.md)). Family `zig`; activation files `build.zig`, `build.zig.zon`; test files `test/`/`tests/` `*.zig`.

## Functions, types and calls

- [functions-classes.ts](functions-classes.ts): `pub fn f(x: T) !R { … }` at file level is a function; `const Order = struct { … };` (or `enum`/`union`/`opaque`) is a type whose fields are properties and whose `fn`s are methods, nested types included. A file is itself a struct: one that declares fields at the top (`Order.zig` with `id: u64,`) is a type named after the file and its functions are its methods. `self` is the receiver, not a parameter. A declaration carries `pub` (or `export`, the C ABI) as an anonymous token ([syntax.ts](syntax.ts)).
- A local initialised by a struct literal (`var c = Car{ .id = 1 }`, `const c = &Car{ .id = 1 }`, i.e. `&Car{…}`) or declared with a type (`var c: Car = .{…}`, `var c: *Car = undefined`) is typed in `FunctionInfo.localTypes`, so `c.park()` links to `Car.park` and not a namesake method on another type.
- [call-hooks.ts](call-hooks.ts): a Zig call is a `call_expression` (`foo(x)`, `repo.save(o)`, `std.debug.print(…)`); a builtin (`@import`, `@intCast`) is a `builtin_function` and calls nothing of the project. Zig has no closures: a function or test block nested in a container is its own scope.

## Imports, packages and dead code

- [imports-exports.ts](imports-exports.ts): `const db = @import("db.zig");` imports a file relative to the importing one; `@import("zap")` a package (named in `build.zig`), `@import("std")` the standard library; `const Router = @import("router.zig").Router;` binds one declaration of it. Every `pub` declaration is an export. `build.zig.zon` is the package manifest ([package-manifests.ts](package-manifests.ts)). Framework hints: `zap`, `httpz`, `jetzig`, `tokamak` (distinctive names only: `pg` is also node-postgres).
- Dead code ([reachability.ts](reachability.ts)): `@import("db.zig")` names a file beside the importer (a package is `@import("zap")`, never a file of this project). What is compiled is what `build.zig` hands the compiler: every `.zig` path it names (`b.path("src/main.zig")`, a module's `root_source_file`) is a root; so is a file with `pub fn main` or a C ABI `export fn`, and a package's conventional root (`src/root.zig`). `build.zig` itself is run by the toolchain; a test file by `zig build test` / `zig test`.

## Routes and data

- Routes ([routes.ts](routes.ts)): http.zig, zap, tokamak and jetzig; jetzig view functions give the method and whether the path takes the resource id.
- Data ([data-sources.ts](data-sources.ts)): SQL in any string or `\\` multiline string (pg.zig `conn.query("SELECT …", .{})`, zqlite/sqlite `db.exec(…)`), one source per statement; `std.http.Client` — `client.fetch(.{ .location = .{ .url = "…" }, .method = .POST })`, and `client.open(.GET, uri, …)` / `client.request(.GET, uri, …)` with the URI parsed from a literal (`try std.Uri.parse("…")`, inline or bound in the file).

## Tests

[test-command.ts](test-command.ts): Zig tests live in the source files that declare them. A project with a package manifest runs through its build (`zig build test` — a build script names which files it tests, and a filter is its own option); without one, each file by itself with a name filter, which Zig matches as a substring of the test's name (`test "ranks clubs"` → `ranks clubs`; a doctest by its declaration).
