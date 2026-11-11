import { beforeAll, describe, expect, it } from "vitest";
import { readCpp } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const links = (source: string, file = "league/main.cpp") => {
  const parsed = readCpp(source);
  expect(parsed.syntaxErrors).toBe(0);
  const a = extractWithRegex(source, file, "cpp", undefined, parsed);
  return buildSymbolLinks([a]);
};
const targets = (all: ReturnType<typeof links>, line: number, pattern = /./) => all.filter((l) => l.sourceLine === line && pattern.test(l.callName)).map((l) => l.targetSymbol + ":" + l.targetLine);

describe("C++ structured bindings over a struct", () => {
  const SOURCE = `struct Club { void sign(); };
struct Player { void sign(); };
struct Standing {
  Club club;
  Player scorer;
  int rank;
};
Standing standing() { return Standing(); }
void Club::sign() { }
void Player::sign() { }
void show() {
  auto [c, p, r] = standing();
  c.sign();
  p.sign();
}
struct Base { Player who; };
struct Derived : Base { Club extra; };
Derived derived() { return Derived(); }
void inherit() {
  auto [x] = derived();
  x.sign();
}
`;
  it("types each name by the field at its position, and nothing over a class with a base", () => {
    const all = links(SOURCE);
    expect(targets(all, 13, /sign/)).toEqual(["Club.sign:9"]);
    expect(targets(all, 14, /sign/)).toEqual(["Player.sign:10"]);
    expect(targets(all, 21, /sign/)).toEqual([]);
  });
});

describe("C++ free operator overload sets", () => {
  // Each comparison in a function of its own: one function's identical calls are one row.
  const SOURCE = `struct Kit { int n; };
struct Boot { int n; };
bool operator==(const Kit& a, const Kit& b) { return a.n == b.n; }
bool operator==(const Kit& a, int b) { return a.n == b; }
bool operator==(const Kit& a, const char* b) { return false; }
bool operator==(const Boot& a, const Boot& b) { return true; }
bool one(Kit k, Kit m) { return k == m; }
bool two(Kit k, int x) { return k == x; }
bool three(Kit k, const char* name) { return k == name; }
bool four(Kit k) { return k == 3; }
bool five(Kit k) { return k == "x"; }
bool six(Boot b) { return b == b; }
bool seven(Kit k, long wide) { return k == wide; }
bool eight(Kit k) { return k == mystery(); }
bool nine(Kit k, Boot b) { return k == b; }
`;
  it("chooses the overload by both operands and links nothing when the right operand does not pick exactly one", () => {
    const all = links(SOURCE);
    const t = (line: number) => targets(all, line, /operator==/);
    expect(t(7)).toEqual(["operator==:3"]);
    expect(t(8)).toEqual(["operator==:4"]);
    expect(t(9)).toEqual(["operator==:5"]);
    expect(t(10)).toEqual(["operator==:4"]);
    expect(t(11)).toEqual(["operator==:5"]);
    expect(t(12)).toEqual(["operator==:6"]);
    expect(t(13)).toEqual([]);
    expect(t(14)).toEqual([]);
    expect(t(15)).toEqual([]);
  });
});

describe("C++ operators on fields", () => {
  const SOURCE = `struct Kit { Kit operator+(const Kit& o) const; };
struct Crest { Crest operator+(const Crest& o) const; };
class Club {
  Kit kit;
  Crest crest;
  int budget;
  Kit* spare;
 public:
  Kit merge(const Kit& other);
  Kit viaThis(const Kit& other) { return this->kit + other; }
  Kit bare(const Kit& other) { return kit + other; }
  int money(int extra) { return budget + extra; }
  Kit pointer(const Kit& other) { return spare + other; }
};
Kit Club::merge(const Kit& other) { return kit + other; }
Kit Kit::operator+(const Kit& o) const { return o; }
Crest Crest::operator+(const Crest& o) const { return o; }
`;
  it("types a field operand from the class's declarations, in or out of line, never a primitive or a pointer", () => {
    const all = links(SOURCE);
    const t = (line: number) => targets(all, line, /operator\+/);
    expect(t(10)).toEqual(["Kit.operator+:16"]);
    expect(t(11)).toEqual(["Kit.operator+:16"]);
    expect(t(12)).toEqual([]);
    expect(t(13)).toEqual([]);
    expect(t(15)).toEqual(["Kit.operator+:16"]);
  });
});

describe("C++ iterators and smart pointers", () => {
  const SOURCE = `struct Club { void sign(); Club operator+(const Club& o) const; };
struct Player { void sign(); };
void record(const Club& c) { }
void record(int n) { }
void Club::sign() { }
void Player::sign() { }
Club Club::operator+(const Club& o) const { return o; }
void declared(std::vector<Club> squad) {
  for (std::vector<Club>::iterator it = squad.begin(); it != squad.end(); ++it) {
    it->sign();
    record(*it);
  }
}
void viaAuto(std::vector<Club> squad) {
  auto first = squad.begin();
  first->sign();
}
void viaAutoArg(std::vector<Club> squad) {
  auto first = squad.begin();
  record(*first);
}
void owned(std::unique_ptr<Club> owner, std::shared_ptr<Club> shared) {
  record(*owner);
  record(*shared);
  Club both = *owner + *shared;
  owner->sign();
}
void loose(std::vector<Club*> pointers) {
  auto stray = pointers.begin();
  stray->sign();
}
void looseArg(std::vector<Club*> pointers) {
  auto stray = pointers.begin();
  record(*stray);
}
void strangers(std::vector<Player> team) {
  auto p = team.begin();
  p->sign();
}
`;
  it("types it->x, *it and *p through the element and the smart pointer", () => {
    const all = links(SOURCE);
    const sign = (line: number) => targets(all, line, /sign/);
    expect(sign(10)).toEqual(["Club.sign:5"]);
    expect(sign(16)).toEqual(["Club.sign:5"]);
    expect(sign(26)).toEqual(["Club.sign:5"]);
    expect(sign(38)).toEqual(["Player.sign:6"]);
    // An element that is a pointer is no `Club` for `it->`, nor for `*it`.
    expect(sign(30)).toEqual([]);
    expect(targets(all, 11, /record/)).toEqual(["record:3"]);
    expect(targets(all, 20, /record/)).toEqual(["record:3"]);
    expect(targets(all, 23, /record/)).toEqual(["record:3"]);
    expect(all.find((l) => l.sourceLine === 34 && l.callName === "record")?.overloadsFit).toBe(2);
    expect(targets(all, 25, /operator\+/)).toEqual(["Club.operator+:7"]);
  });
});
