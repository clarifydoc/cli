import { describe, expect, it } from "vitest";
import { blankSplices } from "./preprocessor-branches.js";
import { readC } from "../c/antlr.js";
import { readCpp } from "../cpp/antlr.js";

describe("line splices and form feeds in C-family sources", () => {
  it("blanks a backslash-newline between tokens, keeping every line and column", () => {
    const source = "extern int kick_off \\\n  (int club);\n";
    const blanked = blankSplices(source);
    expect(blanked).toBe("extern int kick_off  \n  (int club);\n");
    expect(blanked.length).toBe(source.length);
  });

  it("leaves a directive's, a string's and a line comment's continuation alone", () => {
    const source = '#define SCORE(a, b) \\\n  ((a) + (b))\nconst char *s = "goal \\\nkick";\n// a note \\\ncontinued\nint x;\n';
    expect(blankSplices(source)).toBe(source);
  });

  it("blanks a form feed to a space", () => {
    expect(blankSplices("int a;\f\nint b;\n")).toBe("int a; \nint b;\n");
  });

  it("reads C with a split declaration, a split condition and a page break", () => {
    const source = `extern int play_match \\
  (int home, int away);

int play_match(int home, int away) {
  if (home > 0 && \\
      away > 0 ||\\
      home == away) {
    return score(home, away);
  }
\f
  return 0;
}
`;
    const parsed = readC(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine, f.calls.map((c) => c.name)])).toEqual([["play_match", 4, 12, ["score"]]]);
  });

  it("reads C++ with a split macro call too", () => {
    const source = `void sign_player(Club& club) {
  ASSERT_TRUE(club.open() && \\
              club.budget() > 0);
  club.sign();
}
`;
    const parsed = readCpp(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => f.name)).toEqual(["sign_player"]);
  });
});

describe("a conjunction with a __cplusplus term", () => {
  it("leaves out the guard of a C++ includer in C: `#if defined(__cplusplus) && !defined(X)` (real-repo shape)", () => {
    const source = `#if defined (__cplusplus) && !defined(CLUB_NO_GUARD)
extern "C" {
#endif

int club_kick(int power) { return strike(power); }

#if defined (__cplusplus) && !defined(CLUB_NO_GUARD)
} /* extern "C" */
#endif
`;
    const parsed = readC(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["club_kick", ["strike"]]]);
  });

  it("keeps a conjunction without the term, and in C++ the negated one is the dead one", () => {
    const source = `#if defined(CLUB_STRICT) && !defined(CLUB_LOOSE)
int club_pass(int a) { return relay(a); }
#else
int club_pass(int a) { return hold(a); }
#endif
`;
    expect(new Set(readC(source).functions.map((f) => f.name))).toEqual(new Set(["club_pass"]));
    const cpp = `#if !defined(__cplusplus) && defined(CLUB_PLAIN)
extern "C" {
#endif
int club_run(int a) { return jog(a); }
#if !defined(__cplusplus) && defined(CLUB_PLAIN)
}
#endif
`;
    const parsed = readCpp(cpp);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => f.name)).toEqual(["club_run"]);
  });
});

describe("C++26 reflection feature tests left out when the build does not enable them", () => {
  it("blanks a continued #if of reflection feature macros and reads the rest (real-repo shape)", () => {
    const source = `#if defined(__cpp_impl_reflection) && defined(__cpp_lib_reflection) && \\
    defined(__cpp_lib_define_static)
enum class [[=club::as_names]] colour { red, green, blue };
void paint_meta(void) { reflect(colour::red); }
#endif
int paint(int n) { return coat(n); }
`;
    const parsed = readCpp(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["paint", ["coat"]]]);
  });

  it("reads a file that gates reflection on a project macro derived from the feature tests (real-repo shape)", () => {
    const source = `#if defined(__cpp_lib_reflection) || defined(__cpp_impl_reflection)
#define CLUB_REFLECT26 1
#else
#define CLUB_REFLECT26 0
#endif
#if CLUB_REFLECT26
auto members = std::meta::nonstatic_data_members_of(^^Club, ctx());
void meta_kick(void) { use(members); }
#endif
int club_kick(int n) { return strike(n); }
`;
    const parsed = readCpp(source);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => f.name)).toEqual(["club_kick"]);
    // A build that enables the feature tests keeps the reflection arm (the grammar refuses it).
    expect(readCpp(source, [{ name: "__cpp_impl_reflection", value: "1" }, { name: "__cpp_lib_reflection", value: "1" }]).syntaxErrors).toBeGreaterThan(0);
  });

  it("leaves a file that already parses unchanged when reflection macros are mentioned only in a comment", () => {
    const source = `// std::meta and ^^T stay documentation here
int club_kick(int n) { return strike(n); }
`;
    expect(readCpp(source).functions.map((f) => f.name)).toEqual(["club_kick"]);
  });
});
