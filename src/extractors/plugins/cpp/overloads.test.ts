import { beforeAll, describe, expect, it } from "vitest";
import { readCpp } from "./antlr.js";
import { cppOverloadTypeKey } from "./arg-kinds.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const SOURCE = `#include <string>
void record(int goals) { }
void record(long goals) { }
void record(double goals) { }
void record(const std::string& name) { }
template <typename T> T convert(T value) { return value; }
template <> std::string convert<std::string>(std::string value) { return value; }
template <> int convert<int>(int value) { return value; }
void play(std::string name, int shots) {
  record(42);
  record(42L);
  record(1.5f);
  record("Nine");
  record(name);
}
void twice() {
  record(1);
  record(1.0);
}
void unknown(int x) {
  record(mystery());
  record(x + 1);
}
void convertAll(int x) {
  convert<int>(x);
  convert<std::string>("a");
}
`;

const analysis = () => {
  const parsed = readCpp(SOURCE);
  expect(parsed.syntaxErrors).toBe(0);
  return extractWithRegex(SOURCE, "league/scorer.cpp", "cpp", undefined, parsed);
};
const lineOf = (links: ReturnType<typeof buildSymbolLinks>, line: number) => links.filter((l) => l.sourceLine === line && /record|convert/.test(l.callName));

describe("C++ overloads", () => {
  it("reads each call's argument count, kinds and template arguments, one row per distinct call", () => {
    const fns = Object.fromEntries(analysis().functions.map((f) => [f.name, f.calls.filter((c) => c.name === "record" || c.name === "convert")]));
    expect(fns.play!.map((c) => [c.line, c.argCount, c.argKinds])).toEqual([[10, 1, ["int"]], [11, 1, ["long"]], [12, 1, ["float"]], [13, 1, ["string"]], [14, 1, ["@name"]]]);
    expect(fns.twice!.map((c) => c.argKinds)).toEqual([["int"], ["double"]]);
    expect(fns.convertAll!.map((c) => c.templateArgs)).toEqual([["int"], ["std::string"]]);
    expect(analysis().functions.filter((f) => f.name === "convert").map((f) => f.specializedOn)).toEqual([undefined, ["std::string"], ["int"]]);
  });

  it("picks the overload by literal kind, ranking a promotion above a conversion", () => {
    const links = buildSymbolLinks([analysis()]);
    expect(lineOf(links, 10).map((l) => l.targetLine)).toEqual([2]); // 42 -> int
    expect(lineOf(links, 11).map((l) => l.targetLine)).toEqual([3]); // 42L -> long
    expect(lineOf(links, 12).map((l) => l.targetLine)).toEqual([4]); // 1.5f -> double (promotion), not int
    expect(lineOf(links, 13).map((l) => l.targetLine)).toEqual([5]); // "Nine" -> std::string
  });

  it("keeps two calls of one name in a function as two links to different overloads", () => {
    const links = buildSymbolLinks([analysis()]);
    expect([lineOf(links, 17)[0]!.targetLine, lineOf(links, 18)[0]!.targetLine]).toEqual([2, 4]);
  });

  it("leaves a call whose arguments are unknown on a tie, saying how many overloads fit", () => {
    const links = buildSymbolLinks([analysis()]);
    expect(lineOf(links, 21)[0]?.overloadsFit).toBe(4);
  });

  it("chooses an explicit specialization by the template arguments the call writes", () => {
    const links = buildSymbolLinks([analysis()]);
    expect(lineOf(links, 25).map((l) => l.targetLine)).toEqual([8]);
    expect(lineOf(links, 26).map((l) => l.targetLine)).toEqual([7]);
  });

  it("folds declared types to the overload keys", () => {
    expect(["const std::string&", "unsigned long long", "const Club *", "const char *", "std::vector<Club>", "long unsigned int", "bool", "float"].map(cppOverloadTypeKey))
      .toEqual(["string", "long", "Club", "string", "vector<Club>", "long", "boolean", "float"]);
  });
});
