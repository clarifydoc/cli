# C plugin

Reads C (`.c`) through regex patterns with an ANTLR front end (`antlr.ts`, `meta.antlr`); a file with syntax errors keeps the regex reading, and `--feature no-antlr` switches back to it. C is a `cfam` plugin: includes, headers, macros as facts, struct ops tables, callable fields, value flow, `p->m()` naming, vendored banners, reachability, control flow, CMake test commands and the project marker are shared with C++ and described once in [../cpp/AGENTS.md](../cpp/AGENTS.md). `.h` has one owner (C++); a project with `.c` and no C++ source reads its headers C-first (variant `c-first`, in that file). Parser internals — the two-pass reading, the type-name pass, retyped macros, settled decisions — are in [../../../parsers/AGENTS.md](../../../parsers/AGENTS.md).

## What C states

- A function-pointer `copy` of a parameter into a field (`peer->free_fn = fn`) states an `invoke` with `ifFnType` only for a plain typedef name that is no number, no pointer to pointers and no struct the file declares (the corpus showed most of those facts dropped otherwise); `fn` may be typed by a typedef another header declares. A member call is an `invoke` in C always (in C++ only for a member the file stores a callable in).
- `typedef R Name(args)` and `typedef R (*Name)(args)` are `FileAnalysis.functionTypeAliases`, judged over the file's whole include closure.
- An import binds only what its path names: `#include <league/club.h>` binds the bodies of that header only, never `other/club.c`.
- Function-like `#define`s outside a function body are `FileAnalysis.macros`; a call that lands on one also makes the calls the macro's body makes (INFERRED, `SymbolLink.viaMacro`, [../cpp/AGENTS.md](../cpp/AGENTS.md#macros)).
- The reader takes unexpanded macros as grammar rules and a file that does not parse is read again with each conditional's first branch ([../shared/preprocessor-branches.ts](../shared/preprocessor-branches.ts), [../shared/token-calls.ts](../shared/token-calls.ts)); both are shared with C++.
