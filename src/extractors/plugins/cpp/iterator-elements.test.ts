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

const MODEL = `struct Boot { void lace(); };
struct Club { void sign(); };
struct Decoy { void lace(); void sign(); };
`;
const HEADER = `#include "model.h"
#include <vector>
#include <map>
#include <unordered_map>
#include <memory>
class Squad {
public:
  void a(); void b(); void c(); void d(); void e(); void f(); void g(); void h(); void i();
private:
  std::vector<Boot> boots;
  std::vector<Boot*> ptrs;
  std::vector<std::unique_ptr<Boot>> owned;
  std::map<int, Club> clubs;
  std::unordered_map<std::string, Club> byName;
};
`;
const BODIES = `#include "squad.h"
void Boot::lace() {}
void Club::sign() {}
void Decoy::lace() {}
void Decoy::sign() {}
`;
const body = (text: string) => links({ "league/model.h": MODEL, "league/squad.h": HEADER, "league/squad.cpp": `${BODIES}${text}` });

describe("C++ iterators over a field only the header declares", () => {
  it("types `auto it = boots.begin()`, cbegin and find through the header's field", () => {
    const all = body(`void Squad::a() {
  auto it = boots.begin();
  it->lace();
}
void Squad::b() {
  auto it = boots.cbegin();
  (*it).lace();
}
void Squad::c() {
  auto it = clubs.find(3);
  it->second.sign();
}
`);
    expect(at(all, 8)).toEqual(["Boot.lace:2"]);
    expect(at(all, 12)).toEqual(["Boot.lace:2"]);
    expect(at(all, 16)).toEqual(["Club.sign:3"]);
  });
  it("types a range-for over the header's field", () => {
    const all = body(`void Squad::d() {
  for (auto& b : boots) b.lace();
}
`);
    expect(at(all, 7)).toEqual(["Boot.lace:2"]);
  });
});

describe("C++ pointer elements", () => {
  it("types `(*it)->m()` over raw and smart pointer elements", () => {
    const all = body(`void Squad::e() {
  std::vector<Boot*>::iterator it = ptrs.begin();
  (*it)->lace();
}
void Squad::f() {
  auto it = owned.begin();
  (*it)->lace();
}
void Squad::g() {
  std::vector<std::unique_ptr<Boot>>::iterator it = owned.begin();
  (*it)->lace();
}
`);
    for (const l of [8, 12, 16]) {
      expect(at(all, l)).toEqual(["Boot.lace:2"]);
    }
  });
});

describe("C++ map elements", () => {
  it("types `it->first.m()` and `it->second.m()` from the key and value types", () => {
    const all = body(`void Squad::h() {
  std::map<int, Club>::iterator it = clubs.begin();
  it->second.sign();
  it->first.sign();
}
void Squad::i() {
  auto it = byName.find("x");
  it->second.sign();
}
`);
    expect(at(all, 8)).toEqual(["Club.sign:3"]);
    expect(at(all, 9)).toEqual([]);
    expect(at(all, 13)).toEqual(["Club.sign:3"]);
  });
  it("types a key that is a class", () => {
    const all = links({
      "league/model.h": MODEL,
      "league/squad.h": `#include "model.h"\n#include <map>\nclass Roster {\npublic:\n  void a();\nprivate:\n  std::map<Boot, Club> m;\n};\n`,
      "league/squad.cpp": `${BODIES}void Roster::a() {
  auto it = m.begin();
  it->first.lace();
  it->second.sign();
}
`,
    });
    expect(at(all, 8)).toEqual(["Boot.lace:2"]);
    expect(at(all, 9)).toEqual(["Club.sign:3"]);
  });
});

describe("C++ range-for over a map field", () => {
  it("types `p.second.m()` and a structured binding's value from the header's field", () => {
    const all = body(`void Squad::a() {
  for (auto& p : clubs) p.second.sign();
}
void Squad::b() {
  for (const auto& kv : byName) {
    kv.second.sign();
    kv.first.sign();
  }
}
void Squad::c() {
  for (auto& [id, club] : clubs) club.sign();
}
void Squad::d() {
  for (auto& [name, club] : byName) {
    name.sign();
    club.sign();
  }
}
`);
    expect(at(all, 7)).toEqual(["Club.sign:3"]);
    expect(at(all, 11)).toEqual(["Club.sign:3"]);
    expect(at(all, 12)).toEqual([]);
    expect(at(all, 16)).toEqual(["Club.sign:3"]);
    expect(at(all, 20)).toEqual([]);
    expect(at(all, 21)).toEqual(["Club.sign:3"]);
  });
  it("types a key that is a class", () => {
    const all = links({
      "league/model.h": MODEL,
      "league/squad.h": `#include "model.h"\n#include <map>\nclass Roster {\npublic:\n  void a();\nprivate:\n  std::map<Boot, Club> m;\n};\n`,
      "league/squad.cpp": `${BODIES}void Roster::a() {
  for (auto& p : m) { p.first.lace(); p.second.sign(); }
}
`,
    });
    expect(at(all, 7).sort()).toEqual(["Boot.lace:2", "Club.sign:3"]);
  });
});

describe("C++ range-for over a container the function declares", () => {
  it("types a map local's value through `p.second` and a structured binding, and keeps a global's plain name", () => {
    const all = links({
      "league/model.h": MODEL,
      "league/run.cpp": `#include "model.h"
#include <map>
std::map<int, Club> registry;
void Club::sign() {}
void local() {
  std::map<int, Club> m;
  for (auto& p : m) p.second.sign();
  for (auto& [id, club] : m) club.sign();
}
void global() {
  for (auto& p : registry) p.second.sign();
}
`,
    });
    expect(at(all, 7)).toEqual(["Club.sign:4"]);
    expect(at(all, 8)).toEqual(["Club.sign:4"]);
  });
  it("names the call on a global container as written, never `p$second`", () => {
    const a = analyze(`#include <map>
std::map<int, Club> registry;
void global() {
  for (auto& p : registry) p.second.sign();
}
`, "league/run.cpp");
    expect(a.functions.find((f) => f.name === "global")!.calls.map((c) => c.name)).toEqual(["p.second.sign"]);
  });
});

describe("C++ iterator decoys", () => {
  it("types a pointer element only through `(*it)->`, a value element only through `it->`", () => {
    const all = body(`void Squad::a() {
  auto it = ptrs.begin();
  it->lace();
  (*it)->lace();
}
void Squad::b() {
  auto it = boots.begin();
  (*it)->lace();
  (*it).lace();
}
`);
    expect(at(all, 8)).toEqual([]);
    expect(at(all, 9)).toEqual(["Boot.lace:2"]);
    expect(at(all, 13)).toEqual([]);
    expect(at(all, 14)).toEqual(["Boot.lace:2"]);
  });
  it("keeps a project class's own find as an ordinary call", () => {
    const all = links({
      "league/model.h": "struct Boot { void lace(); };\nstruct Decoy { void lace(); };\nstruct Store { Boot* find(int id); };\n",
      "league/squad.h": "#include \"model.h\"\nclass Squad {\npublic:\n  void a();\nprivate:\n  Store store;\n};\n",
      "league/squad.cpp": `${BODIES}Boot* Store::find(int id) { return 0; }
void Squad::a() {
  auto found = store.find(2);
  found->lace();
}
`,
    });
    expect(at(all, 9)).toEqual(["Boot.lace:2"]);
  });

  it("never reads a local that shadows the header's field", () => {
    const all = body(`void Squad::a() {
  std::vector<Decoy> boots;
  auto it = boots.begin();
  it->lace();
}
`);
    expect(at(all, 8).join()).not.toContain("Boot.lace");
  });
  it("links a `first` / `second` member on neither a vector nor a map of primitives", () => {
    const all = body(`void Squad::a() {
  auto it = boots.begin();
  it->first.sign();
}
void Squad::b() {
  auto it = byName.find("x");
  it->first.sign();
}
`);
    expect(at(all, 8)).toEqual([]);
    expect(at(all, 12)).toEqual([]);
  });
  it("links a member of the wrong class on no iterator", () => {
    const all = body(`void Squad::a() {
  auto it = ptrs.begin();
  (*it)->sign();
  auto jt = clubs.begin();
  jt->second.lace();
}
`);
    expect(at(all, 8).join()).not.toContain("Decoy");
    expect(at(all, 8).join()).not.toContain("Club");
    expect(at(all, 10)).toEqual([]);
  });
});
