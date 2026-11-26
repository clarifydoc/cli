# Haskell plugin

Reads `.hs` / `.lhs` through a regex `RegexLangSpec` ([index.ts](index.ts)) with a tree-sitter front end (`meta.treeSitter`, [tree-sitter.ts](tree-sitter.ts); `parsing` stays `"regex"`, feature `tree-sitter`, off with `no-tree-sitter:haskell`) supplying functions and calls; a file with syntax errors keeps the regex reading. Loading and error counting of the grammar are in [parsers/AGENTS.md](../../../parsers/AGENTS.md).

## Files

- [tree-sitter.ts](tree-sitter.ts) — applications, signature + equations as one function; [index.ts](index.ts) — spec, infix operators, doc comments (`--` dash docs, `DASH_DOCS`).
- [package-manifests.ts](package-manifests.ts) / `packages.ts` — Hackage from `.cabal`; [reachability.ts](reachability.ts) — dead code (a convention spec from the shared kit).

Family `haskell`. Framework hints: `Yesod`, `Servant`, `Web.Scotty`, `Database.Persist`. Test files: `*Spec.hs`, `*Test.hs`; a test's subject is the file with the suffix removed. Haskell states no `testCommand` or `projectCommands`.
