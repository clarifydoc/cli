import { describe, expect, it } from "vitest";
import { readC } from "./antlr.js";

const shape = (source: string) => {
  const parsed = readC(source);
  return { errors: parsed.syntaxErrors, functions: parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)]) };
};

describe("C macro shapes the first pass retypes or sets aside", () => {
  it("reads a name before `*MACRO name` as a type: the macro qualifies the pointer", () => {
    const source = `void tally(club_pts *CLUB_RESTRICT points, const club_pts *CLUB_RESTRICT extra, size_t n) {
  add_points(points, extra, n);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["tally", ["add_points"]]] });
  });

  it("reads `TYPE_MACRO NAME_MACRO(x);` in a struct body as a member", () => {
    const source = `struct match_buffer {
  int kind;
  CLUB_TYPE CLUB_FIELD(score);
  unsigned CLUB_FIELD(flags) : 2;
};
void reset(struct match_buffer *b) { clear(b); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["reset", ["clear"]]] });
  });

  it("sets aside a macro written before a cast, which stands for part of it", () => {
    const source = `void arm(struct timer *t) {
  t->data = CLUB_DATA_T (uintptr_t) 0;
  start(t);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["arm", ["start"]]] });
  });

  it("reads a macro in the place of a type keyword inside a cast", () => {
    const source = `void show(char *out, const char *fmt, int n) {
  emit_line(out, fmt, (unsigned CLUB_INT_T)score(n));
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["show", ["emit_line", "score"]]] });
  });

  it("sets aside a list macro between the entries of an initializer", () => {
    const source = `static const struct entry table[] = {
  ENTRY(a_first, "first", 1),
  ALL_BINARY_ENTRIES
  ENTRY(a_last, "last", 1),
  FOR_EACH_EXTRA(EMIT)
  { 0 }
};
void use(void) { look(table); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["use", ["look"]]] });
  });

  it("keeps a block macro of a function body, where the same shape is no initializer", () => {
    const source = `void run(struct club *c) {
  FOR_EACH_PLAYER(c)
  {
    train(c);
  }
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["run", ["FOR_EACH_PLAYER", "train"]]] });
  });

  it("keeps a type after an attribute, where no macro stands", () => {
    const source = `static __attribute__ ((unused)) club_row_t make_row (int id)
{
  return build(id);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["make_row", ["build"]]] });
  });

  it("reads a lowercase macro between an attribute and the declared name", () => {
    const source = `static inline club_t *
__attribute__ ((always_inline)) league_internal
acquire_club (club_ctx_t *ctx, int id)
{
  return find(ctx, id);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["acquire_club", ["find"]]] });
  });

  it("reads a bare macro line before a member assignment as a statement of its own", () => {
    const source = `struct club { int w; };
static void tick(struct club *c, struct club *col) {
  CLUB_COUNTERS
  col[1].w = 10;
  CLUB_PUSH
  c->w = 3;
  CLUB_MARK
  c.w = 4;
  flush(c);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["tick", ["flush"]]] });
  });

  it("keeps a declaration after a macro line a declaration", () => {
    const source = `static void tick(void) {
  CLUB_SCOPE
  struct club *c[2];
  CLUB_SCOPE
  club_t row[3];
  flush(c);
}
`;
    expect(shape(source).errors).toBe(0);
  });

  it("sets aside a macro call between a `*` and the function's name", () => {
    const source = `static inline const char * CLUB_FORMAT_ARG(3)
club_emit(char *out, size_t size, const char *fmt) {
  put(out);
}
int tally(int a, int b) {
  int r = a * SCALE(b);
  return r * area(a);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_emit", ["put"]], ["tally", ["SCALE", "area"]]] });
  });

  it("sets aside a macro before an attribute that precedes the declared name", () => {
    const source = `static int
club_internal __attribute ((pure))
name_of(int a) {
  return look(a);
}
static __attribute__ ((unused)) club_row_t load_row(int a) { return fetch(a); }
club_t __attribute__((aligned(8))) slot;
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["name_of", ["look"]], ["load_row", ["fetch"]]] });
  });

  it("sets aside a macro between a prototype's parameters and its attribute", () => {
    const source = `static unsigned int context_at (const club_t *input, int idx,
                                  int flags)
     club_internal __attribute ((pure));
int get(int a) __attribute__((pure));
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("sets aside a macro qualifying an array bound", () => {
    const source = `void fill(const int m[_Club_restrict_ CLUB_LEN (n)]) { copy(m); }
`;
    expect(shape(source).errors).toBe(0);
  });

  it("reads member macros before a struct's closing brace, and macros ending a file", () => {
    const source = `struct club_s {
  CLUB_DATA_SLOW
  club_state_t state;
  CLUB_DATA_FAST
  CLUB_DATA_SLOWER
};
void kick(void) { go(); }

CLUB_DATA_SLOW
CLUB_DATA_FAST
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("sets aside a list macro between enumerators, and a bare one before the last (real-repo shape)", () => {
    const source = `typedef enum {
  CLUB_UNKNOWN = 0,
#define EMIT(uc, lc) CLUB_##uc,
  CLUB_KIND_MAP(EMIT)
#undef EMIT
  CLUB_FILE,
  CLUB_KIND_MAX
  CLUB_KIND_PRIVATE
  CLUB_KIND_END
} club_kind;
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("keeps the enumerators of an enum whose entries are separated by commas", () => {
    const source = `enum club_kind { CLUB_A, CLUB_B = 2, CLUB_C };
enum { CLUB_X, CLUB_Y, };
enum club_old { CLUB_OLD_A CLUB_DEPRECATED(8.3, "") = 3, CLUB_OLD_B CLUB_DEPRECATED(7.5, ""), CLUB_OLD_C };
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("reads a macro seen before a declaration, again before another macro (real-repo shape)", () => {
    const source = `CLUB_EXPORT
int first(void) { return one(); }
CLUB_EXPORT CLUB_NOINLINE
int second(void) { return two(); }
CLUB_EXPORT
CLUB_NOINLINE
static int third(void) { return three(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["first", ["one"]], ["second", ["two"]], ["third", ["three"]]] });
  });

  it("reads a call-like statement macro at file scope before an initialized variable (real-repo shape)", () => {
    const source = `int club_one(void) { return a(); }
#ifdef CLUB_LIBC
club_alias (club_one, one)
#endif
static const club_set_t full = {
  [0 ... 0x80 / CLUB_BITS - 1] = CLUB_MAX
};
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_one", ["a"]], ["kick", ["go"]]] });
  });

  it("keeps a K&R definition after a file-scope macro call as a definition", () => {
    const source = `club_declare (match)
int score(a, b) int a; int b; { return add(a, b); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["score", ["add"]]] });
  });

  it("reads a run of list macros with keyword arguments, then a bare macro, before a declaration (real-repo shape)", () => {
    const source = `CLUB_TARGET_WIDE
CLUB_COUNT_FN(union, club_or)
CLUB_COUNT_FN(and, club_and)
CLUB_OFFSIDE_WIDE
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("reads a statement macro with no `;` before `else` (real-repo shape)", () => {
    const source = `void swap_all(char *a, char *b, long n, int c) {
  if (c)
    CLUB_SWAP(long, a, b, n)
  else
    CLUB_SWAP(char, a, b, n)
  done(a);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["swap_all", ["CLUB_SWAP", "done"]]] });
  });

  it("keeps a call statement before `else`, where a `;` ends it", () => {
    const source = `void swap_all(char *a, char *b, int c) {
  if (c) swap(a, b); else swap(b, a);
  done(a);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["swap_all", ["swap", "done"]]] });
  });

  it("reads two member macros before a member's type (real-repo shape)", () => {
    const source = `struct club_pipe_s {
  CLUB_HANDLE_FIELDS
  CLUB_STREAM_FIELDS
  int ipc;
  club_t CLUB_FIELD_A;
  CLUB_PIPE_PRIVATE_FIELDS
};
void kick(void) { go(); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["kick", ["go"]]] });
  });

  it("reads a bare macro before a macro the file also uses as a specifier (real-repo shape)", () => {
    const source = `CLUB_PRIVATE_TYPES
CLUB_EXTERN int club_open(club_t* req);
CLUB_EXTERN int club_close(const char* x);
CLUB_ALIGNED
int club_first(void *v) { return one(v); }
CLUB_TARGET_WIDE
CLUB_ALIGNED
int club_second(void *v) { return two(v); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_first", ["one"]], ["club_second", ["two"]]] });
  });

  it("reads a bare macro before a list macro call, where the same name stood before a keyword (real-repo shape)", () => {
    const source = `CLUB_TARGET
static inline unsigned club_sum(const club_vec v) {
  return add(v);
}
CLUB_TARGET
CLUB_COUNT_FN(or, club_or)
CLUB_COUNT_FN(union, club_union)
CLUB_OFFSIDE
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_sum", ["add"]]] });
  });
});
