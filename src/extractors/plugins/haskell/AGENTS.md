# Haskell plugin

Reads `.hs` / `.lhs` through a regex `RegexLangSpec` ([index.ts](index.ts)) with a tree-sitter front end (`meta.treeSitter`, [tree-sitter.ts](tree-sitter.ts); `parsing` stays `"regex"`, feature `tree-sitter`, off with `no-tree-sitter:haskell`) supplying functions and calls; a file with syntax errors keeps the regex reading. Loading and error counting of the grammar are in [parsers/AGENTS.md](../../../parsers/AGENTS.md).

## Functions and calls

- The front end reads applications without parentheses as calls; a type signature and its equations are ONE function. A top-level declaration defines a function when it is an equation, or a binding without arguments.  Infix operators are read by their symbol spelling ([index.ts](index.ts); [infix test](infix.test.ts)).
- Doc comments: `--` dash docs (`DASH_DOCS`).

## Modules, packages and dead code

- Family `haskell`. Hackage: every `build-depends:` block of a `.cabal` file, continuation lines included ([package-manifests.ts](package-manifests.ts)). Standard module prefixes (`Data.`, `Control.`, `System.`, `GHC.`, `Text.`, `Network.`, `Prelude`) are external, not project modules. Framework hints: `Yesod`, `Servant`, `Web.Scotty`, `Database.Persist`.
- Test files: `*Spec.hs`, `*Test.hs`; a test's subject is the file with the `Spec`/`Test` suffix removed.
- Dead code ([reachability.ts](reachability.ts), a convention spec from the shared kit): `import Data.Foo` names `Data/Foo.hs` under a source directory. Entries: `main`, `Main.hs`, `app/`, and a library's `exposed-modules` (public API — alive, but no program starts there) read from `*.cabal` / `package.yaml`.
- Haskell states no `testCommand` or `projectCommands`.
