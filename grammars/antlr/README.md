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
| `rust/` | [grammars-v4](https://github.com/antlr/grammars-v4) `rust/` at `d1689adc` (2026-10-26) | MIT (in the files) |
| `c/` | [grammars-v4](https://github.com/antlr/grammars-v4) `c/` at `d1689adc` (2026-10-26) | BSD (in the files) |

The target-specific base classes upstream ships for the `antlr4` JavaScript runtime
(`golang/TypeScript/GoParserBase.ts`, `lua/TypeScript/Lua*Base.ts`, `rust/Antlr4ng/Rust*Base.ts`) are ported to antlr4ng
beside the generated code. C's (`c/Antlr4ng/C*Base.ts`) are replaced, see below.

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

- **Rust, lexer:**
  - One rule for every block comment, which may hold `*`. Upstream's `~[*]` refused a doc comment with a Markdown
    list.
  - An empty `//` or `///` line ends at its newline. Upstream's swallowed the next line.
  - One escape per backslash in strings, so `"\\"` ends where it should.
  - `c"…"` strings, tabs as whitespace, and `~` as a token.
  - SHEBANG and FLOAT_LITERAL predicates moved after their first characters. A predicate at a rule's start kept the
    lexer from caching any DFA state, at about 60 KB/s, and moving them made lexing about 230× faster.
- **Rust, parser: newer syntax.** `let … else`, let chains in `if`/`while` (`condition`, replacing `ifLetExpression`
  and the `while let` rule), `async` closures, `_ =`, `const { }`, `&raw const`/`&raw mut`, `..=x` patterns,
  associated-type bounds and where-clauses, const-generic defaults, `use<…>` capturing, `#[unsafe(…)]`, `#[doc =
  include_str!(…)]`, `$keyword` metavariables, `union` as a name, and `&&T` as a type.
- **Rust, parser: ambiguities removed.**
  - Tuple, unit and enum-variant struct expressions had exactly the shapes of calls and paths.
  - The four alternatives of `genericArgs` described the same input.
  - `foo!(…);` was a statement, an item and an expression.
  - A cast type is its own rule (`castType`), so no type is followed by `<`.
  - Block-like statements and match arms are read once: the statement-start rule `statementExpression` mirrors
    `expression` without a block-like leftmost operand, and `statementsTail`/`matchArmBody` end at one `;`/`,`.
  - A block-like statement may go on with `.`/`?` steps, as rustc allows.

  Upstream's parse ran at about 60 KB/s and failed on 5–30% of real files. Now SLL prediction succeeds nearly
  everywhere, and on nine real repositories only rustc's own error fixtures and unstable syntax fail.

- **C: no preprocessor.** Upstream's lexer base ran `gcc -E` on each file, and its parser base resolved a typedef name
  through a symbol table the parse filled — empty without the headers, so 90–95% of real files failed. The lexer has
  no base class; the parser's (`CParserBase.ts`) reads the names the file's first pass found used as types
  (`CTypes.ts`: its own typedefs, `T *x` and `T x,` at a declaration's start, casts, compound literals, the `_t`
  convention), fixed for the whole parse. Directives are hidden tokens, and `#if 0` / `#ifdef __cplusplus` are blanked
  before the parse.
- **C: unexpanded macros as rules.** A loop or block macro before a statement (`for_each_item(i, list) { … }`), a
  statement macro whose arguments are a declaration or a block (`VERBOSE(size_t n = 0);`, `EACH(x, { … });`), a macro
  called at file scope or as a struct member, an attribute macro among specifiers or after a declarator
  (`NO_CHECKS("x") static int f(`, `int fd UNUSED`), a macro between string literals (`"%" PRIu64`), a type as a
  macro argument (`offsetof(struct x, y)`) and `va_arg(ap, char *)`. A macro's arguments are a balanced token list.
  `$` in names, form feeds as whitespace, a directive's block comment running past its line, C23 `static_assert`.
- **C: flatter expressions.** An assignment's left side is a conditional expression, so one token decides it (upstream
  read past the whole operand first); the ten binary-operator levels are one rule, without precedence. The same
  strings parse.

  Without the preprocessor 5–22% of the files of six real C repositories still fail and keep the patterns' reading.
  The reader runs at 1.1–3.2 MB/s, about three times upstream's grammar with the first pass alone.

The Go changes together made the parse about 12× faster cold and 14× warm on a sample of that codebase, and let SLL
prediction succeed on all but 2 of its files, with no file failing to parse.

## Measuring

`node scripts/ab-features.mjs <project> --feature antlr` analyzes a tree with and without the feature and reports every
disagreement, with examples.
