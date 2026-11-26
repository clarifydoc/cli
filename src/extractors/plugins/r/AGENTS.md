# R plugin

Reads R with tree-sitter (`@davisvaughan/tree-sitter-r`, never the unscoped `tree-sitter-r`, a security placeholder; flat tree copy, `FLAT_TREE_LANGUAGES`): Plumber annotations and `pr_get` routes, Shiny screens, DBI/httr data access. Package files are `DESCRIPTION` and `renv.lock`.

## Project pass ([package-pass.ts](./package-pass.ts), `projectPasses`)

- A `pkg::f()` of the DESCRIPTION's own `Package:` joins the one `f` in that package's `R/`.
- `rank(x) <- v` is a call of `` `rank<-` `` and `a %op% b` of `` `%op%` ``; both are kept only where the project defines them.

## Types and generics ([generic-resolver.ts](./generic-resolver.ts))

- `p <- X$new()` types `p` as `X`.
- A `setGeneric` is a function whose calls fan out to its `setMethod` bodies, INFERRED.
