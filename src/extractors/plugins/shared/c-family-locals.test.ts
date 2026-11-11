import { describe, it, expect } from "vitest";
import { cFamilyTypeName, extractCFamilyLocalTypes } from "./c-family-locals.js";
import type { ParamInfo } from "../../../types/analysis.js";

const locals = (body: string, params: ParamInfo[] = []) =>
  extractCFamilyLocalTypes(body.split("\n"), params).map((l) => (l.from ? `${l.name} <- ${l.from}` : `${l.name}: ${l.type}`));

describe("C and C++ locals", () => {
  it("types a declaration by what it states, however it is initialized", () => {
    expect(locals(`
  Crate c;
  Crate d = Crate();
  Kit k(3);
  Kit braced{3};
  Coach* ptr = new Coach();
  const Coach& ref = pick();
  std::unique_ptr<league::Coach> owned;
  struct garage *g = garage_open(1);
  Box<int> b;
`)).toEqual([
      "c: Crate",
      "d: Crate",
      "k: Kit",
      "braced: Kit",
      "ptr: Coach",
      "ref: Coach",
      "owned: unique_ptr<league::Coach>",
      "g: garage",
      "b: Box<int>",
    ]);
  });

  it("types `auto` by what its initializer constructs, else by the call it is", () => {
    expect(locals(`
  auto p = new Coach(1);
  auto c = Crate{};
  auto sp = std::make_unique<Coach>();
  auto* physio = dynamic_cast<Physio*>(staff);
  auto r = repo.find(id);
  auto s = Store::open(path);
  auto t = this->pick()->first();
  auto u = Crate(3);
  auto slot = Jobs::Slot::Create(10u);
  auto owned = std::unique_ptr<Coach>(new Coach);
`)).toEqual([
      "r <- repo.find(id)",
      "s <- Store::open(path)",
      "t <- this.pick().first()",
      "u <- Crate(3)",
      "slot <- Jobs::Slot::Create(10u)",
      "p: Coach",
      "c: Crate",
      "sp: Coach",
      "physio: Physio",
      "owned: unique_ptr<Coach>",
    ]);
  });

  it("reads several declarators, range-for, catch and a condition's declaration", () => {
    expect(locals(`
  Car a, *b = make(), c(3);
  for (Player* p : squad) p->train();
  for (auto& q : squad) q.rest();
  try { kick(); } catch (const Foul& f) { f.note(); }
  if (Coach* head = find()) head->drill();
  if (goals < limit && shots > misses) score();
`)).toEqual(["a: Car", "b: Car", "c: Car", "p: Player", "f: Foul", "head: Coach", "q: "]);
  });

  it("leaves out primitives and statements that declare nothing; a name bound twice or untyped is untold", () => {
    expect(locals(`
  int n = 0;
  unsigned long long laps = 0;
  return Crate();
  delete p;
  x = y * z;
  std::cout << "goal" << std::endl;
  club.play(3);
  Q_EMIT scored(1);
  Coach twice;
  Physio twice;
  auto [home, away] = score();
  // Crate commented;
`)).toEqual(["home <- score()", "away <- score()", "twice: "]);
  });

  it("keeps a parameter's own type; a local shadowing one of another type is untold, so the parameter never answers it", () => {
    expect(locals("  Coach coach;\n  Kit kit;\n  auto pick = choose();\n  auto& brake = *slot;", [
      { name: "coach", type: "const Coach&", defaultValue: null },
      { name: "kit", type: "Crate", defaultValue: null },
      { name: "pick", type: "Engine", defaultValue: null },
      { name: "brake", type: "Engine", defaultValue: null },
    ])).toEqual(["coach: Coach", "brake: ", "pick: ", "kit: "]);
  });
});

describe("C-family type names", () => {
  it("spells a declared type as the parameters do", () => {
    // A namespace in front of a class stays: `away::Club` is not another namespace's `Club`. The standard
    // library's goes, as does one in front of a lowercase name.
    expect(cFamilyTypeName("const std::vector<league::Club>&")).toBe("vector<league::Club>");
    expect(cFamilyTypeName("struct garage *")).toBe("garage");
    expect(cFamilyTypeName("::league::Coach* const")).toBe("league::Coach");
    expect(cFamilyTypeName("asio::io_context&")).toBe("io_context");
    expect(cFamilyTypeName("league::Paddock<K, C>::Iterator")).toBe("league::Paddock::Iterator");
  });
});
