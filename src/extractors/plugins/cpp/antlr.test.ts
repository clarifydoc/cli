import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { readCpp } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

/** Functions and methods as the C++ spec reads them with the parser's reading: `[name, line, calls]`. */
const read = (source: string) => {
  const parsed = readCpp(source);
  return { errors: parsed.syntaxErrors, functions: parsed.syntaxErrors ? [] : shape(extractWithRegex(source, "league.cpp", "cpp", undefined, parsed)) };
};

const shape = (a: FileAnalysis) => [
  ...a.functions.map((f) => [f.name, f.line, f.calls.map((c) => c.name)]),
  ...a.classes.flatMap((c) => c.methods.map((m) => [`${c.name}::${m.name}`, m.line, m.calls.map((x) => x.name)])),
];

describe("C++ through ANTLR", () => {
  it("tells a declaration from an expression without the headers", () => {
    const source = `void kick(Club *c) {
  memcpy(&shirt, c, sizeof(shirt));
  Squad squad;
  std::vector<Player> bench;
  Player *keeper = pick(squad);
}
`;
    expect(read(source)).toEqual({ errors: 0, functions: [["kick", 1, ["memcpy", "pick"]]] });
  });

  it("tells template arguments from comparisons, and casts from parenthesized values", () => {
    const source = `void play(Match *m) {
  if (goals < limit && shots > 3) score();
  auto team = make_team<Club>(1);
  auto *p = (Player *)raw;
  double r = (a) * b;
  ((Club *)m->home)->promote();
  os << name << Mode::kFull;
}
`;
    expect(read(source).functions).toEqual([["play", 1, ["score", "make_team", "promote"]]]);
  });

  it("names calls as the C++ patterns do", () => {
    const source = `void build(Garage *g) {
  Club::create(1);
  std::sort(cars.begin(), cars.end());
  g->bay()->lift(2);
  g->doors.lock();
  this->reset();
  new Car(3);
  Car spare(4);
}
`;
    // A construction `Car spare(4)` declares, it calls nothing.
    expect(read(source).functions).toEqual([["build", 1, ["Club.create", "sort", "cars.begin", "cars.end", "bay", "lift", "doors.lock", "reset", "Car"]]]);
  });

  it("names a definition by its last name, a destructor and an operator as written, and reads initializer lists", () => {
    const source = `Club::Club(int id) : Base(id), name_(load(id)) {}
Club::~Club() { release(); }
bool Club::operator==(const Club &other) const { return same(other); }
template <typename T> void Squad<T>::add(T player) { store(player); }
`;
    expect(read(source).functions).toEqual([
      ["Club::Club", 1, ["Base", "name_", "load"]],
      ["Club::~Club", 2, ["release"]],
      ["Club::operator==", 3, ["same"]],
      ["Squad::add", 4, ["store"]],
    ]);
  });

  it("reads the macros a file does not expand", () => {
    const source = `class EXPORT Stadium : public QObject {
  Q_OBJECT
  Q_PROPERTY(int seats READ seats)
 public slots:
  void open(QString gate) EXCLUSIVE_LOCKS_REQUIRED(mu_);
 private:
  int seats_ GUARDED_BY(mu_);
};
void Stadium::open(QString gate) {
  connect(turnstile_, SIGNAL(passed(Fan *)), this, SLOT(count()));
  emit opened(gate);
}
TEST(Stadium, Opens) {
  SECTION("main gate") { check(admit("north")); }
  QFETCH(bool, full);
}
`;
    expect(read(source)).toEqual({
      errors: 0,
      functions: [
        ["TEST", 13, ["SECTION", "check", "admit", "QFETCH"]],
        ["Stadium::open", 9, ["connect", "SIGNAL", "passed", "SLOT", "count", "opened"]],
      ],
    });
  });

  it("reads code a C++ compiler sees, and each platform's branch where the file only parses so", () => {
    const source = `#ifdef __cplusplus
extern "C" {
#endif
#if 0
void legacy() { old(); }
#endif
#ifdef _WIN32
int start_engine(HANDLE ignition) {
#else
int start_engine(int ignition) {
#endif
  return ignite(ignition);
}
#ifdef __cplusplus
}
#endif
`;
    expect(read(source).functions).toEqual([["start_engine", 8, ["ignite"]]]);
  });

  it("reads fold expressions, forwarding packs and attributes on declarations", () => {
    const source = `template <typename... Args>
void announce(Args &&...args) {
  (std::cout << ... << args);
  (cheer(args), ...);
  [[maybe_unused]] auto ok = (check(args) && ...);
}
`;
    expect(read(source).functions).toEqual([["announce", 2, ["cheer", "check"]]]);
  });

  it("reads bare macros, contextual keywords as members, and a dereferenced template call in an initializer", () => {
    const source = `BEGIN_NAMESPACE
void replay(Match *m) {
  BENCHMARK_LOOP { rewind(m); }
  m->final();
  Item a(*cast<const Item *>(m));
  SET_SOURCE_PATH
  return finish(m);
}
END_NAMESPACE
`;
    expect(read(source).functions).toEqual([["replay", 2, ["BENCHMARK_LOOP", "rewind", "final", "cast", "SET_SOURCE_PATH", "finish"]]]);
  });

  it("reads an all-caps parameter name, and casts inside a macro's arguments", () => {
    const source = `void doTest(std::shared_ptr<Case> TEST_CTX) {
  auto l = [](Ctx TEST_CTX) { kick(); };
  if (UNLIKELY(m->id != (unsigned)Pitch::Home)) restart();
  CHECK((int)(unsigned char)shirt[0] == 0x8A);
}
`;
    expect(read(source).functions).toEqual([["doTest", 1, ["kick", "UNLIKELY", "restart", "CHECK"]]]);
  });

  it("counts a syntax error and reads nothing more of the file, so core keeps the patterns' reading", () => {
    expect(readCpp("int f() { return (1; }\n")).toMatchObject({ functions: [] });
    expect(readCpp("int f() { return (1; }\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → [only the patterns,
 * only the parser]`, as `[name, line, calls]`. The patterns miss a template call and an inline destructor.
 */
const KNOWN: Record<string, [unknown[], unknown[]]> = {
  "test-fixtures/sample-cpp-app/main.cpp": [
    [["main", 16, ["repo.add", "repo.find", "repo.size"]]],
    [["main", 16, ["repo.add", "make_shared", "repo.find", "repo.size"]]],
  ],
  "test-fixtures/sample-cpp-app/Player.h": [[], [["Player::~Player", 10, []]]],
};

describe("C++: ANTLR and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync(["test-fixtures/**/*.cpp", "test-fixtures/**/*.h"], { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readCpp(src);
      expect(parsed.syntaxErrors).toBe(0);
      const regex = shape(extractWithRegex(src, rel, "cpp"));
      const tree = shape(extractWithRegex(src, rel, "cpp", undefined, parsed));
      const has = (list: unknown[][], x: unknown[]) => list.some((y) => JSON.stringify(y) === JSON.stringify(x));
      expect([regex.filter((x) => !has(tree, x)), tree.filter((x) => !has(regex, x))]).toEqual(KNOWN[rel] ?? [[], []]);
    });
  }
});
