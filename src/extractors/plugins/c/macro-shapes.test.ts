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
});
