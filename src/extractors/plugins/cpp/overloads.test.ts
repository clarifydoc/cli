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
void log(int level, const std::string& line) { }
void log(int level, const char* format, ...) { }
void report() {
  log(1, "Full time");
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
    // A literal is a `const char*` exactly; `std::string` is a conversion away, so the C-string overload wins.
    expect(links.filter((l) => l.callName === "log").map((l) => l.targetLine)).toEqual([29]);
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
      .toEqual(["basic_string", "long", "Club", "string", "vector<Club>", "long", "boolean", "float"]);
  });
});

const LOCALS = `struct Club { int id; };
struct Player { int id; };
void record(const Club& club) { }
void record(int goals) { }
void sign(const Player& p) { }
void sign(int n) { }
void play() {
  Club c;
  record(c);
}
void viaAuto() {
  auto c = Club();
  record(c);
}
void viaPointer(Club* c) {
  record(*c);
}
void viaParam(const Club& c, int n) {
  record(c);
  record(n);
}
void viaDeclAndInit() {
  Club c{};
  Player p;
  record(c);
  sign(p);
}
class Season {
  Club club;
  int rounds;
  void open() {
    record(club);
    record(rounds);
  }
  void close() {
    record(this->club);
  }
};
void viaSmart() {
  std::unique_ptr<Club> u;
  record(*u);
}
`;

describe("C++ overloads, typed variables", () => {
  const run = () => {
    const parsed = readCpp(LOCALS);
    expect(parsed.syntaxErrors).toBe(0);
    const a = extractWithRegex(LOCALS, "league/club.cpp", "cpp", undefined, parsed);
    return buildSymbolLinks([a]).filter((l) => /record|sign/.test(l.callName));
  };
  const at = (links: ReturnType<typeof run>, line: number) => links.filter((l) => l.sourceLine === line).map((l) => l.targetLine);
  it("chooses by a typed local, an auto local, a dereferenced pointer, a parameter and a field", () => {
    const links = run();
    expect(at(links, 9)).toEqual([3]);
    expect(at(links, 13)).toEqual([3]);
    expect(at(links, 16)).toEqual([3]);
    expect(at(links, 19)).toEqual([3]);
    expect(at(links, 20)).toEqual([4]);
    expect(at(links, 25)).toEqual([3]);
    expect(at(links, 26)).toEqual([5]);
    expect(at(links, 32)).toEqual([3]);
    expect(at(links, 33)).toEqual([4]);
    expect(at(links, 36)).toEqual([3]);
    // A smart pointer's pointee is what `*u` is.
    expect(at(links, 41)).toEqual([3]);
  });
});
