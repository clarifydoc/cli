import { describe, expect, it } from "vitest";
import { readC } from "./antlr.js";
import { blankAsm } from "./rewrites.js";

const names = (source: string) => {
  const parsed = readC(source);
  return { errors: parsed.syntaxErrors, functions: parsed.functions.map((f) => f.name) };
};

describe("C forms the line patterns used to keep", () => {
  it("reads a lowercase statement macro before } without a semicolon", () => {
    expect(names("void tour(void) {\n  for (int i = 0; i < 3; i++) {\n    garage_log_end(car)\n  }\n}\n")).toEqual({ errors: 0, functions: ["tour"] });
  });

  it("reads a bare caps macro closing a block opened by if", () => {
    expect(names("void tour(int n) {\n  if (n) {\n    GARAGE_POP\n  }\n}\n")).toEqual({ errors: 0, functions: ["tour"] });
  });

  it("reads a macro whose arguments hold an operator", () => {
    expect(names("void check(int goals) {\n  check_int(goals, ==, 3);\n  kick(goals);\n}\n")).toEqual({ errors: 0, functions: ["check"] });
  });

  it("reads a macro list of one-capital X lines and a closing LIST_END", () => {
    const source = "#define X(a, b) int run_##a##b(void) { return a + b; }\nX(1, 1)\nX(1, 10)\n";
    expect(names(source).errors).toBe(0);
    expect(names("CLUB_DECLARE (rovers)\nCLUB_LIST_START\n  CLUB_ENTRY (rovers)\n  CLUB_ENTRY (united)\nCLUB_LIST_END\n").errors).toBe(0);
  });

  it("reads two Windows conventions in a row and a function-pointer variable", () => {
    expect(names("WINBASEAPI BOOL WINAPI GetClubSize(HANDLE club, PLARGE_INTEGER size) {\n  return 1;\n}\n")).toEqual({ errors: 0, functions: ["GetClubSize"] });
    expect(names("typedef struct _CLUBFD {\n  int fd;\n} CLUBFD, *PCLUBFD, FAR *LPCLUBFD;\n").errors).toBe(0);
    expect(names("typedef const char *(APIENTRY *CLUB_NAME_FN)(void);\n").errors).toBe(0);
    expect(names("_CRTIMP errno_t __cdecl club_open_s(FILE **file, const char *name);\n").errors).toBe(0);
  });

  it("reads __declspec(align(n)) in a body and deprecated as a name", () => {
    expect(names("void tour(void) {\n  __declspec(align(8)) char buffer[64];\n  int deprecated = 0;\n  kick(deprecated);\n}\n")).toEqual({ errors: 0, functions: ["tour"] });
  });

  it("reads a label or default ending a block", () => {
    expect(names("int pick(int n) {\n  switch (n) {\n    case 1:\n      go();\n    default:\n  }\ndone:\n}\n")).toEqual({ errors: 0, functions: ["pick"] });
  });

  it("reads string macros joined without a literal beside them", () => {
    expect(names("static const char *label(void) {\n  const char *s = HOME_PREFIX AWAY_PREFIX;\n  return s;\n}\n")).toEqual({ errors: 0, functions: ["label"] });
    expect(names("void show(void) {\n  say(SEP, HOME SEP AWAY, 1);\n}\n")).toEqual({ errors: 0, functions: ["show"] });
  });

  it("blanks an asm statement, keeping lines, and reads a file with one", () => {
    const source = "static int swap_club(int *p) {\n  int r;\n  __asm__ volatile (CLUB_LOCK \"xchg %0, %1\" : \"=a\" (r) : \"m\" (*p) : \"memory\");\n  asm volatile(\"\" ::: \"memory\");\n  return r;\n}\n";
    const blanked = blankAsm(source);
    expect(blanked.split("\n").length).toBe(source.split("\n").length);
    expect(blanked).not.toContain("xchg");
    expect(names(source)).toEqual({ errors: 0, functions: ["swap_club"] });
  });
});
