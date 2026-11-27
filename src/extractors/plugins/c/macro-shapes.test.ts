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

  it("reads a run of macros before a keyword when the first was a member macro of a struct (real-repo shape)", () => {
    const source = `struct club_state {
  CLUB_SLOW
  club_phase_t phase;
};

CLUB_SLOW
CLUB_SLOWER
CLUB_INLINE void
club_kick(club_t *c) {
  strike(c);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_kick", ["strike"]]] });
    // the same names in a declaration stay one: the run ends at a lowercase name, no keyword follows
    const decoy = `struct club_state {
  CLUB_SLOW
  club_phase_t phase;
};

CLUB_SLOW CLUB_SLOWER pace;
void club_stop(void) { halt(); }
`;
    expect(shape(decoy)).toEqual({ errors: 0, functions: [["club_stop", ["halt"]]] });
  });

  it("reads bare macros around a list macro call when the names are types to the first pass (real-repo shape)", () => {
    const source = `CLUB_TARGET
static inline unsigned club_sum(const club_vec v) {
  return add(v);
}

CLUB_COUNT_FN(xor, club_xor)
CLUB_OFFSIDE

CLUB_TARGET
CLUB_COUNT_FN(and, club_and)
CLUB_OFFSIDE
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_sum", ["add"]]] });
  });

  it("reads a macro between `*` and a qualifier, and a macro call before a declaration in a body (real-repo shape)", () => {
    const source = `int club_run(club_state_t *s, int len) {
  const club_u8 *const end = s->p + len;
  CLUB_ALIGN(CLUB_STRIDE) club_u64 acc[8];
  club_u64 *CLUB_RESTRICT const fast = s->acc;
  copy(acc, fast, sizeof(acc));
  return len;
}
void club_pack(club_u64 *CLUB_RESTRICT const out) { store(out); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_run", ["CLUB_ALIGN", "copy"]], ["club_pack", ["store"]]] });
    // the same names as expressions stay expressions: a product with a macro, a call statement followed by a call
    const decoy = `int club_scale(int a) {
  int total = a * CLUB_FACTOR;
  CLUB_TRACE(a)
  launch(total);
  CLUB_ALIGN(8);
  return total * CLUB_FACTOR + a;
}
`;
    expect(shape(decoy)).toEqual({ errors: 0, functions: [["club_scale", ["CLUB_TRACE", "launch", "CLUB_ALIGN"]]] });
  });

  it("reads a run of macros ending in a call at the end of a file, after the name stood before a type (real-repo shape)", () => {
    const source = `CLUB_INLINE CLUB_PURE club_score_t
club_pass(const club_u8 *CLUB_RESTRICT input, int n)
{
  return tally(input, n);
}

CLUB_INLINE CLUB_TARGET CLUB_TEMPLATE(fast)
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_pass", ["tally"]]] });
  });

  it("counts no nested-function header of a dropped body as a call, and every real call (real-repo shape)", () => {
    const source = `int rank_table(int n)
{
  int base = 0;
#ifdef CLUB_NESTED
  auto inline int32_t
  __attribute ((always_inline))
  bonus (home, away)
	 const unsigned char *home;
	 size_t away;
    {
      return add_points (home, away);
    }
  auto inline club_t *penalty (int fouls)
    {
      return count_cards (fouls);
    }
  static int helper (int x) { return x; }
  if (check_rule (base)) { whistle (); }
  base = (club_t) convert (n) + bonus (n, 1) + penalty (n);
  base = total * scale (n);
#endif
  return base + points_for (n);
}
`;
    const rank = readC(source).functions.find((f) => f.name === "rank_table")!;
    expect(readC(source).syntaxErrors).toBe(0);
    expect(rank.calls.map((c) => c.name)).toEqual([
      "add_points", "count_cards", "check_rule", "whistle", "convert", "bonus", "penalty", "scale", "points_for",
    ]);
  });

  it("reads a function named by a call macro after two leading macros and a `_t` type (real-repo shape)", () => {
    const source = `typedef struct {
  void *ptr;
  size_t size;
} club_result_t;

CLUB_EXPORT CLUB_ALLOC
club_result_t CLUB_NOTHROW
/* why a plain attribute cannot be used */
CLUB_JOIN2(club_make_, CLUB_VERSION)
  (size_t size, int flags) {
  return tally(size, flags);
}

club_result_t club_next(int n) { return step(n); }
`;
    const parsed = readC(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([
      ["CLUB_JOIN2", ["tally"]],
      ["club_next", ["step"]],
    ]);
    // three leading macros, and a prototype run the same way, stay declarations
    const decoy = `CLUB_A CLUB_B CLUB_C
club_result_t
CLUB_JOIN(club_, make)
  (int n) {
  return tally(n);
}

CLUB_A CLUB_B club_result_t club_peek(int n);

int club_scale(int n) { return n * CLUB_SCALE(n); }
`;
    const read = readC(decoy);
    expect(read.syntaxErrors).toBe(0);
    expect(read.functions.map((f) => f.name)).toEqual(["CLUB_JOIN", "club_scale"]);
  });

  it("leaves out the one `#ifdef` body that holds a GNU nested function, and no other (real-repo shape)", () => {
    const source = `#ifdef CLUB_TRACE
void trace_line(int n) { log_line(n); }
#endif

int rank_table(int n)
{
  int base = 0;
#ifdef CLUB_NESTED
  auto inline int bonus (home, away)
	 int home;
	 int away;
    {
      return add_points(home, away);
    }
  auto inline int penalty (int fouls)
    {
      return count_cards(fouls);
    }
  base = bonus(n, 1) + penalty(n);
#endif
  return base + points_for(n);
}

void other(void) { kick_off(); }
`;
    const parsed = readC(source);
    expect(parsed.syntaxErrors).toBe(0);
    // the functions of every other conditional stay; the dropped body's calls still count where they fall
    expect(parsed.functions.map((f) => f.name)).toEqual(["trace_line", "rank_table", "other"]);
    const rank = parsed.functions.find((f) => f.name === "rank_table")!;
    expect(rank.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["points_for", "add_points", "count_cards"]));
    // a conditional with an `#else` is not a lone body: it stays refused, as before
    const decoy = `int rank_table(int n)
{
#ifdef CLUB_NESTED
  auto inline int bonus (int home) { return add_points(home); }
#else
  int bonus = 0;
#endif
  return bonus + points_for(n);
}
`;
    expect(readC(decoy).syntaxErrors).toBeGreaterThan(0);
    // a conditional outside every function (an include guard, a top-level `#ifdef`) is never left out: it holds definitions
    const guarded = `#ifndef CLUB_GUARD_H
#define CLUB_GUARD_H
static inline int club_twice(int n) { return n +; }
#endif
`;
    expect(readC(guarded).syntaxErrors).toBeGreaterThan(0);
    // a refusal outside every conditional stays a refusal
    expect(readC("int f(void) { return 1 +; }\n#ifdef CLUB_X\nint g(void) { return 2; }\n#endif\n").syntaxErrors).toBeGreaterThan(0);
  });

  it("reads a `_t` name that is indexed and then read for a member as a variable (real-repo shape)", () => {
    const source = `static void fill_cols(club_col_t *name, club_col_t col_goals_t[GOAL_KINDS], club_col_t col_cards_t[CARD_KINDS]) {
	CLUB_COLUMN_LIST
	col_goals_t[kind_total].width = 10;
	col_cards_t[0]->width = 4;
	paint(name);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["fill_cols", ["paint"]]] });
    // a `_t` name that is declared stays a type: `club_t[3]` is never followed by a member access
    const decoy = `typedef int club_t;
club_t scores[3];
void show(void) { club_t first = scores[0]; announce(first); }
`;
    expect(shape(decoy)).toEqual({ errors: 0, functions: [["show", ["announce"]]] });
  });

  it("reads a type definition after a call macro with no `;` and a forward declaration of it (real-repo shape)", () => {
    const source = `club_define(match_t, match)

typedef struct squad_s squad_t;
struct squad_s {
	int size;
	club_match_t match;
};

static void *
squad_reader(void *arg) {
	return load(arg);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["squad_reader", ["load"]]] });
    // a K&R definition after a call macro keeps its parameters: the `{` after them is the body
    const kr = `club_define(match_t, match)
int tally(a, b)
	int a;
	int b;
{
	return add(a, b);
}
`;
    expect(shape(kr)).toEqual({ errors: 0, functions: [["tally", ["add"]]] });
  });

  it("sets aside a macro between a basic type keyword and `*`, and a run of attribute macros before the name (real-repo shape)", () => {
    const source = `CLUB_EXPORT CLUB_ALLOCATOR
void CLUB_NOTHROW *
CLUB_ATTR(malloc) CLUB_SIZE(1)
club_alloc(size_t size) {
	return grab(size);
}
void *
CLUB_ATTR(malloc)
club_calloc(size_t n) { return grab(n); }
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["club_alloc", ["grab"]], ["club_calloc", ["grab"]]] });
    // the same names as expressions stay expressions
    const decoy = `int club_scale(int a, int *p) {
	int total = a * CLUB_FACTOR;
	int more = *p * CLUB_ATTR(2) + total;
	return total * CLUB_SIZE(1) + more;
}
`;
    expect(shape(decoy)).toEqual({ errors: 0, functions: [["club_scale", ["CLUB_ATTR", "CLUB_SIZE"]]] });
  });
});
