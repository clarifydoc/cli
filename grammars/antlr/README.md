# ANTLR grammars

Grammars for the `antlr` feature (`src/core/feature-flags.ts`, on by default): an ANTLR4 parser reads the functions and
calls of a language the regex path otherwise reads by pattern. The parsers are generated with
[antlr-ng](https://github.com/mike-lischke/antlr-ng) for the [antlr4ng](https://github.com/mike-lischke/antlr4ng)
runtime into `src/parsers/antlr/<lang>/`, and the generated TypeScript is committed:

```bash
node scripts/generate-antlr.mjs          # every grammar here
node scripts/generate-antlr.mjs go       # one
```

Each generated file starts with its grammar's licence block, which the bundle keeps in `dist/`.

| Folder | Upstream | Licence |
|---|---|---|
| `go/` | [grammars-v4](https://github.com/antlr/grammars-v4) `golang/` at `d1689adc` (2026-10-26) | BSD (in the files) |
| `lua/` | [grammars-v4](https://github.com/antlr/grammars-v4) `lua/` at `d1689adc` (2026-10-26) | MIT (in the files) |

The target-specific base classes upstream ships for the `antlr4` JavaScript runtime
(`golang/TypeScript/GoParserBase.ts`, `lua/TypeScript/Lua*Base.ts`) are ported to antlr4ng beside the generated code.

## Changes from upstream

Every change is marked `[ClarifyDoc …]` in the grammar, except the `@header` imports, which the upstream build inserts
per target at its `// Insert here @header` marker.

- **Go: predicates read tokens only.** Upstream's `isOperand` / `isMethodExpr` read a table of the file's import names,
  filled by parser actions. ANTLR caches predictions in a DFA shared by every parse and assumes a predicate means the
  same in each, so a file could parse with or without errors depending on the file parsed before it (5 of one large
  codebase's 3,168 files did). The table, its actions and the `methodExpr` alternative are gone. `pkg.Name` and `x.Field` both
  read as a name and a selector, and `T.Method` / `(*T).Method` are ordinary selectors.
- **Go: `eos` has no empty alternative.** The lists (statements, struct fields, interface elements, grouped
  declarations) separate their items, so the last terminator may be left out before `)` / `}` as Go allows.
  Upstream's predicate-guarded empty `eos` is invisible to SLL lookahead, so after any type a terminator could
  vanish, and prediction read whole function bodies to rule it out.
- **Go: a conversion's function or pointer type must be parenthesized** (`(func())(f)`, `(*T)(p)`), as the Go spec
  requires. `*NewCtx(app)` is then a dereferenced call, as Go reads it, and a signature's `result?` is decided by
  its next token.
- **Go: `operandName` is an identifier only**, which removes a qualified/unqualified ambiguity; type arguments may
  follow a selector (`lru.New[string, *Item](n)`).
- **Go additions:** type parameters on a method (`func (c *Ctx) JSON[T any](v T)`). In the base class, `new(expr)`
  is read as an expression when its argument opens with a literal, calls a name or selects past a package's type, and
  a parenthesized type opens a conversion (`([]*T)(nil)`).
- **Lua, lexer:** LuaJIT's integer suffixes (`0x01ULL`, `12LL`) and imaginary numbers (`12i`).
- **Lua, base class:** `IsFunctionCall` looks past the whole name path (`a.b[c].d`) for a call. Upstream looked one
  token past the first name, so `gio.File.open(p):read()` parsed as the variable `gio.File.open` and a second
  statement `(p):read()`.

The Go changes together made the parse about 12× faster cold and 14× warm on a sample of that codebase, and let SLL
prediction succeed on all but 2 of its files, with no file failing to parse.

## Measuring

`node scripts/ab-features.mjs <project> --feature antlr` analyzes a tree with and without the feature and reports every
disagreement, with examples.
