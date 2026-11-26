# OCaml plugin

Reads `.ml` and `.mli` with a tree-sitter front end (`ocaml_interface` grammar for `.mli`); `family: ocaml`. The tree is read through a flat copy (OCaml is in `FLAT_TREE_LANGUAGES`).

## Modules

- A file IS its module class: `Db.find` states its receiver type, so the linker resolves it on `db.ml`.
- String `let`s are `FileAnalysis.moduleValues` (bare and, after the file module is renamed to its stem, `Paths.clubs`) and `ClassInfo.fieldValues` on that module.

## Routes

- Dream and Opium routes are read.
- A path that is a module value (`Dream.get Paths.clubs handler`, or a nested `module Paths = struct let garages = "/api/garages" end`) is `RouteInfo.pathTemplate` `${Paths.clubs}`. Core's `resolveRouteTemplates` fills the hole; a same-named `let clubs` in another module never substitutes.

## Data

- Caqti and ppx_rapper SQL is read.

## Packages, discovery and dead code

- `opam` files and `dune-project` name the packages.
- The manifest's `sourceDirs` re-admits a `bin/` that holds a `dune` file: it is source, not .NET-style build output.

