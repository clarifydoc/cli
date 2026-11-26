import { describe, expect, it } from "vitest";
import { readC } from "../../extractors/plugins/c/antlr.js";

// scripts/lib/c-reduce.mjs is plain JavaScript a script runs; a variable path keeps tsc out of it.
const path = "../../../scripts/lib/c-reduce.mjs";
const lib = (await import(/* @vite-ignore */ path)) as {
  flatten: (lines: Array<{ t: string; n: number; c: string }>, which: string, cplusplus?: boolean) => Array<{ t: string; n: number }>;
  logicalLines: (text: string) => Array<{ t: string; n: number; c: string }>;
  reduceRefused: (
    text: string,
    refused: (t: string) => boolean,
    options?: { configs?: string[] },
  ) => { results: Array<{ config: string; text?: string; line?: number; skipped?: string }>; best: { config: string; text: string } | null; notRefused?: boolean };
};

const refused = (text: string) => readC(text).syntaxErrors > 0;
const texts = (lines: Array<{ t: string }>) => lines.map((l) => l.t).join("\n").trimEnd();

// A header written once per build before one body: each branch closes another bracket, so no candidate that keeps
// the conditional keeps the brackets balanced. The cause (a nested function, which the grammar has no rule for) sits
// in the `#ifdef CLUB_LIVE` branch.
const SOURCE = `#include <club.h>
#define CLUB_MAX 4

int club_tally(int a);

#ifdef CLUB_LIVE
int club_report(int a, int b
#else
int club_report(int a
#endif
)
{
#ifdef CLUB_LIVE
  auto inline int club_pair(int x) { return x + 1; }
#endif
  return club_pair(a);
}

int club_rest(void) { return kick(); }
`;

describe("scripts/lib/c-reduce.mjs", () => {
  it("settles a conditional to its first or its other branch, both lines and numbers kept", () => {
    const lines = lib.logicalLines("int a;\n#if CLUB_X\nint b;\n#else\nint c;\n#endif\nint d;\n");
    expect(texts(lib.flatten(lines, "first"))).toBe("int a;\nint b;\nint d;");
    expect(texts(lib.flatten(lines, "second"))).toBe("int a;\nint c;\nint d;");
    expect(texts(lib.flatten(lib.logicalLines("int a;\n#ifdef CLUB_X\nint b;\n#endif\n"), "off"))).toBe("int a;");
    expect(lib.flatten(lines, "second").map((l) => l.n)).toEqual([1, 5, 7, 8]);
  });

  it("leaves out a branch no compiler of the language takes, a conjunction with a __cplusplus term too", () => {
    const text = "#if defined(__cplusplus) && !defined(CLUB_X)\nextern \"C\" {\n#endif\nint a;\n";
    expect(texts(lib.flatten(lib.logicalLines(text), "first", false))).toBe("int a;");
    expect(texts(lib.flatten(lib.logicalLines(text), "first", true))).toContain("extern");
  });

  it("scans brackets across lines: a comment's apostrophe and parentheses count for nothing", () => {
    const [a, b, c] = lib.logicalLines("/* it's (open\n and ) closed */ int x(\n  int y);");
    expect([a!.c.trim(), b!.c.trim(), c!.c.trim()]).toEqual(["", "int x(", "int y);"]);
  });

  it("reduces a file the reader refuses through a conditional that closes different brackets, and says where it first refuses", () => {
    expect(refused(SOURCE)).toBe(true);
    const { results, best } = lib.reduceRefused(SOURCE, refused, { configs: ["first", "asis"] });
    const first = results.find((r) => r.config === "first")!;
    expect(first.text).toContain("auto inline");
    expect(first.text).not.toContain("club_rest");
    expect(first.text).not.toContain("#if");
    expect(refused(first.text!)).toBe(true);
    // the unit the reader first refuses: club_report, line 7 of the file
    expect(first.line).toBe(7);
    expect(best).not.toBeNull();
    expect(best!.text.length).toBeLessThanOrEqual(first.text!.length);
  });

  it("skips a configuration the reader reads, and reports a file that is not refused", () => {
    const { results } = lib.reduceRefused(SOURCE, refused, { configs: ["off"] });
    expect(results[0]!.skipped).toMatch(/reads this configuration/);
    expect(lib.reduceRefused("int a(void) { return 1; }\n", refused).notRefused).toBe(true);
  });
});
