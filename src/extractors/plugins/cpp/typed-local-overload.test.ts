/**
 * E-365: a call whose argument is a local of a built-in type (`int shirt`, `const char* tag`, `double pace`) chooses the
 * overload that type selects. A primitive local has no `localTypes` entry (nothing to call on it), so the reading states
 * its overload key on the call. The overload of the matching type is declared first and last in turn, so a link that
 * keeps the last-declared definition cannot pass both.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readCpp } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const squad = (reversed: boolean) => {
  const overloads = ["  int pick(int shirt) { return 1; }", "  int pick(const std::string& name) { return 2; }", "  int pick(const char* tag) { return 3; }", "  int pick(double pace) { return 4; }"];
  return `#include <string>
class Squad {
 public:
${(reversed ? [...overloads].reverse() : overloads).join("\n")}
};
class Coach {
  void number(Squad& squad) { int shirt = 7; squad.pick(shirt); }
  void text(Squad& squad) { std::string who = "Ada"; squad.pick(who); }
  void tag(Squad& squad) { const char* tag = "Bo"; squad.pick(tag); }
  void pace(Squad& squad) { double pace = 1.5; squad.pick(pace); }
  void param(Squad& squad, int shirt) { squad.pick(shirt); }
  void again(Squad& squad, int who) {
    { std::string inner = "z"; squad.pick(inner); }
    squad.pick(who);
  }
};
`;
};

const chosen = (source: string, read: (s: string) => FileAnalysis | undefined): Record<string, string> => {
  const a = read(source)!;
  const calls = Object.fromEntries(buildSymbolLinks([a]).filter((l) => /pick/.test(l.callName)).map((l) => [l.sourceSymbol, source.split("\n")[l.targetLine - 1]!.trim().replace(/^int pick\((.*?)\).*$/, "$1")]));
  return calls;
};

const antlr = (s: string): FileAnalysis => {
  const parsed = readCpp(s);
  expect(parsed.syntaxErrors).toBe(0);
  return { ...extractWithRegex(s, "league/squad.cpp", "cpp", undefined, parsed), projectId: "root" };
};

describe("C++ typed local argument (E-365)", () => {
  it.each([[false], [true]])("chooses by the local's built-in type (reversed declarations: %s)", (reversed) => {
    expect(chosen(squad(reversed), antlr)).toMatchObject({
      "Coach.number": "int shirt",
      "Coach.text": "const std::string& name",
      "Coach.tag": "const char* tag",
      "Coach.pace": "double pace",
      "Coach.param": "int shirt",
    });
  });

  it("reads a built-in local's key onto the call, a class, `auto` and a redeclared name stay `@name`", () => {
    const a = antlr(`class Club {};
void use(Club& c, int n) { int shirt = 1; Club mine; auto x = shirt; { int n2 = 2; } pick(shirt); pick(mine); pick(x); pick(n); pick(c); }
void twice() { int shirt = 1; { const char* shirt = "a"; pick(shirt); } }`);
    const kinds = Object.fromEntries(a.functions.map((f) => [f.name, f.calls.filter((c) => c.name === "pick").map((c) => c.argKinds?.[0])]));
    expect(kinds.use).toEqual(["int", "@mine", "@x", "@n", "@c"]);
    expect(kinds.twice).toEqual(["@shirt"]);
  });
});
