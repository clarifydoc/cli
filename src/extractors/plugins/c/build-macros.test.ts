import { describe, expect, it } from "vitest";
import { readC } from "./antlr.js";
import { readCpp } from "../cpp/antlr.js";
import "../../registry.js";

const calls = (source: string, macros?: Parameters<typeof readC>[1]) => readC(source, macros).functions.flatMap((f) => f.calls.map((c) => c.name));

const SOURCE = `#ifdef USE_VAR
int kick(void) { return var_assist(); }
#else
int kick(void) { return plain_assist(); }
#endif
`;

describe("macros a build states pick the live arm of a conditional", () => {
  it("reads both arms as today when no build states a macro", () => {
    expect(calls(SOURCE)).toEqual(["var_assist", "plain_assist"]);
  });

  it("takes the #ifdef arm for a macro the command line defines, the #else arm for one it undefines", () => {
    expect(calls(SOURCE, [{ name: "USE_VAR", value: "1" }])).toEqual(["var_assist"]);
    expect(calls(SOURCE, [{ name: "USE_VAR", undefined: true }])).toEqual(["plain_assist"]);
  });

  it("leaves a macro the build does not state unknown", () => {
    expect(calls(SOURCE, [{ name: "OTHER", value: "1" }])).toEqual(["var_assist", "plain_assist"]);
  });

  it("judges defined(), negation, && / || and a macro's number", () => {
    const text = (cond: string) => `#if ${cond}\nvoid a(void) { yes(); }\n#else\nvoid a(void) { no(); }\n#endif\n`;
    const macros = [{ name: "A", value: "1" }, { name: "N", value: "3" }, { name: "Z", undefined: true }];
    expect(calls(text("defined(A) && !defined(Z)"), macros)).toEqual(["yes"]);
    expect(calls(text("defined(Z) || defined A"), macros)).toEqual(["yes"]);
    expect(calls(text("defined(Z) || defined(Q)"), macros)).toEqual(["yes", "no"]);
    expect(calls(text("N >= 4"), macros)).toEqual(["no"]);
    expect(calls(text("N == 3 && A"), macros)).toEqual(["yes"]);
  });

  it("follows #elif and #ifndef", () => {
    const text = "#ifndef A\nvoid f(void) { first(); }\n#elif defined(B)\nvoid f(void) { second(); }\n#else\nvoid f(void) { third(); }\n#endif\n";
    expect(calls(text, [{ name: "A", value: "1" }, { name: "B", value: "1" }])).toEqual(["second"]);
    expect(calls(text, [{ name: "A", value: "1" }, { name: "B", undefined: true }])).toEqual(["third"]);
    expect(calls(text, [{ name: "A", undefined: true }])).toEqual(["first"]);
  });

  it("counts the file's own #define and #undef where every conditional around it is known", () => {
    const own = "#define USE_VAR 1\n" + SOURCE;
    expect(calls(own, [])).toEqual(["var_assist"]);
    expect(calls("#undef USE_VAR\n" + SOURCE, [{ name: "USE_VAR", value: "1" }])).toEqual(["plain_assist"]);
  });

  it("does not trust a #define inside a conditional whose outcome is unknown", () => {
    const text = "#ifdef FAST\n#define USE_VAR 1\n#endif\n" + SOURCE;
    expect(calls(text, [{ name: "USE_VAR", undefined: true }])).toEqual(["var_assist", "plain_assist"]);
    // The header guard idiom: defined inside an arm the build cannot decide, so unknown after it.
    const guarded = "#ifndef LEAGUE_H\n#define LEAGUE_H\n#endif\n#ifdef LEAGUE_H\nvoid a(void) { yes(); }\n#else\nvoid a(void) { no(); }\n#endif\n";
    expect(calls(guarded, [])).toEqual(["yes", "no"]);
  });

  it("reads C++ the same way", () => {
    expect(readCpp(SOURCE, [{ name: "USE_VAR", value: "1" }]).functions.flatMap((f) => f.calls.map((c) => c.name))).toEqual(["var_assist"]);
  });
});
