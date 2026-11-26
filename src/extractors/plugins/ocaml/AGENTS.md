# OCaml plugin

Reads `.ml` and `.mli` with a tree-sitter front end (`ocaml_interface` grammar for `.mli`); `family: ocaml`. The tree is read through a flat copy (OCaml is in `FLAT_TREE_LANGUAGES`).

- A file IS its module class: `Db.find` states its receiver type, so the linker resolves it on `db.ml`. A dotted `Head.member` whose import names the head may match the owner's file stem case-insensitively (`Paths` → `paths.ml`).
- [module-values.ts](module-values.ts) — string `let`s are `FileAnalysis.moduleValues` (bare and, after the file module is renamed to its stem, `Paths.clubs`) and `ClassInfo.fieldValues` on that module; [routes.ts](routes.ts) — Dream and Opium routes, a path that is a module value is `RouteInfo.pathTemplate` `${Paths.clubs}` that core's `resolveRouteTemplates` fills (a same-named `let clubs` in another module never substitutes).
- [data-sources.ts](data-sources.ts) (Caqti, ppx_rapper), [package-manifests.ts](package-manifests.ts) (`opam`, `dune-project`). The manifest's `sourceDirs` re-admits a `bin/` that holds a `dune` file: it is source, not .NET-style build output.
