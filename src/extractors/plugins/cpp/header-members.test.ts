import { beforeAll, describe, expect, it } from "vitest";
import { readCpp } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const analyze = (source: string, file: string) => {
  const parsed = readCpp(source);
  expect(parsed.syntaxErrors).toBe(0);
  return extractWithRegex(source, file, "cpp", undefined, parsed);
};
const links = (files: Record<string, string>) => buildSymbolLinks(Object.entries(files).map(([f, s]) => analyze(s, f)));
const at = (all: ReturnType<typeof links>, line: number) => all.filter((l) => l.sourceLine === line).map((l) => `${l.targetSymbol}:${l.targetLine}`);

const MODEL = `struct Kit { void wash(); Kit operator+(const Kit& o); };
struct Boot { void lace(); Boot* club(); };
struct Decoy { void wash(); void lace(); Decoy operator+(const Decoy& o); };
`;
const HEADER = `#include "model.h"
#include <vector>
#include <memory>
class Club {
public:
  void play(); void a(); void b(); void c(); void d(); void e();
private:
  Kit kit;
  int count;
  std::vector<Boot> boots;
};
`;
const BODIES = `#include "club.h"
void Kit::wash() {}
Kit Kit::operator+(const Kit& o) { return *this; }
void Boot::lace() {}
Boot* Boot::club() { return 0; }
void Decoy::wash() {}
void Decoy::lace() {}
Decoy Decoy::operator+(const Decoy& o) { return *this; }
`;

describe("C++ a method defined beside a header's class (real-repo FP)", () => {
  it("types an operator on a field the header declares, and nothing on a primitive", () => {
    const all = links({
      "league/model.h": MODEL,
      "league/club.h": HEADER,
      "league/club.cpp": `${BODIES}void Club::play() {
  kit + kit;
  count + 1;
  this->kit + kit;
}
`,
    });
    // `kit` is a `Kit`, not a `Decoy`; `count` is an int the header states.
    expect(at(all, 10)).toEqual(["Kit.operator+:3"]);
    expect(at(all, 11)).toEqual([]);
    expect(at(all, 12)).toEqual(["Kit.operator+:3"]);
  });
  it("links a name no class declares nothing, even when one class alone has the operator", () => {
    const all = links({
      "league/model.h": `struct Kit { Kit operator+(const Kit& o); };\n`,
      "league/club.h": HEADER,
      "league/club.cpp": `#include "club.h"
Kit Kit::operator+(const Kit& o) { return *this; }
void Club::play() {
  count + 1;
  kMax + 2;
}
`,
    });
    expect(at(all, 4)).toEqual([]);
    expect(at(all, 5)).toEqual([]);
  });
});

describe("C++ dereferenced iterators and smart pointers", () => {
  const body = (text: string) => links({ "league/model.h": MODEL, "league/club.h": HEADER, "league/club.cpp": `${BODIES}${text}` });
  it("types `(*it).m()` like `it->m()`, over an iterator and a unique_ptr", () => {
    const all = body(`void Club::a() {
  std::vector<Boot>::iterator it = boots.begin();
  (*it).lace();
}
void Club::b() {
  std::unique_ptr<Boot> p;
  (*p).lace();
}
`);
    expect(at(all, 11)).toEqual(["Boot.lace:4"]);
    expect(at(all, 15)).toEqual(["Boot.lace:4"]);
  });
  it("follows a chain from the iterator and `std::next(it)->m()`", () => {
    const all = body(`void Club::c() {
  std::vector<Boot>::iterator it = boots.begin();
  std::next(it)->lace();
}
void Club::d() {
  std::vector<Boot>::iterator it = boots.begin();
  it->club()->wash();
}
`);
    expect(at(all, 11)).toEqual(["Boot.lace:4"]);
    expect(at(all, 15)).toEqual(expect.arrayContaining(["Boot.club:5"]));
    expect(at(all, 15).join()).not.toContain("Decoy");
  });
  it("links nothing for an element that is itself a pointer or a primitive", () => {
    const all = body(`void Club::e() {
  std::vector<Boot*> ptrs;
  std::vector<Boot*>::iterator it = ptrs.begin();
  (*it)->lace();
  int n;
  (*n).lace();
}
`);
    expect(at(all, 12).join()).not.toContain("Decoy");
    expect(at(all, 14)).toEqual([]);
  });
  it("types neither a project function named next nor a path through the element's fields", () => {
    const all = body(`Boot* next(Boot* b) { return b; }
void Club::e() {
  std::vector<Boot>::iterator it = boots.begin();
  next(it)->lace();
  it->club.lace();
}
`);
    expect(at(all, 12).join()).not.toContain("Boot.lace");
    expect(at(all, 13)).toEqual([]);
  });
});
