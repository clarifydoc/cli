import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { cppSpec } from "./index.js";
import { extractCppClasses, outOfLineOwner } from "./classes.js";

const lines = (src: string) => src.split("\n");
const classesOf = (src: string) => {
  const l = lines(src);
  return extractCppClasses(l, extractFunctionsWithSpec(l, cppSpec), cppSpec);
};
const methodNames = (cls: { methods: { name: string }[] } | undefined) => cls?.methods.map((m) => m.name);

describe("C++ out-of-line method definitions", () => {
  const playerCpp = `
#include "Player.h"

namespace app {

Player::Player(int id, std::string name)
    : id_(id), name_(std::move(name)) {}

std::string Player::displayName() const {
    return name_.empty() ? std::string{"(unknown)"} : name_;
}

std::string AdminPlayer::displayName() const {
    return "[" + role_ + "] " + Player::displayName();
}

static int helper(int x) {
    return x * 2;
}

}  // namespace app
`;

  it("attaches each definition to a stub of its class, so same-named bodies stay apart", () => {
    const classes = classesOf(playerCpp);
    expect(classes.map((c) => c.name)).toEqual(["Player", "AdminPlayer"]);
    expect(methodNames(classes[0])).toEqual(["Player", "displayName"]);
    expect(methodNames(classes[1])).toEqual(["displayName"]);
    // The base-class call names its class (`Player::displayName()`).
    expect(classes[1]!.methods[0]!.calls.map((c) => c.name)).toContain("Player.displayName");
  });

  it("removes the attached definitions from the top-level functions (no double count)", () => {
    const a = extractWithRegex(playerCpp, "Player.cpp", "cpp");
    expect(a.functions.map((f) => f.name)).toEqual(["helper"]);
    expect(a.classes.flatMap((c) => c.methods.map((m) => `${c.name}.${m.name}`))).toEqual([
      "Player.Player", "Player.displayName", "AdminPlayer.displayName",
    ]);
  });

  it("does not take a namespace qualifier for a class", () => {
    const classes = classesOf(`
namespace util {
int parse(const char* s);
}

int util::parse(const char* s) {
    return atoi(s);
}

void detail::flush() {
    sync();
}
`);
    expect(classes).toEqual([]);
  });

  it("attaches to the file's own class declaration when it has one", () => {
    const classes = classesOf(`
class Local {
public:
    int value() const;
};

int Local::value() const {
    return 42;
}
`);
    expect(classes).toHaveLength(1);
    expect(methodNames(classes[0])).toEqual(["value"]);
    expect(classes[0]!.methods[0]!.line).toBe(7);
  });

  it("reads the owner off nested and templated qualifiers", () => {
    expect(outOfLineOwner("void Outer::Inner::run() {", "run")).toBe("Outer::Inner");
    expect(outOfLineOwner("void Paddock<K, C>::Iterator::Next() {", "Next")).toBe("Paddock::Iterator");
    expect(outOfLineOwner("void Stack<T>::push(const T& v) {", "push")).toBe("Stack");
    expect(outOfLineOwner("Player::~Player() {", "~Player")).toBe("Player");
    expect(outOfLineOwner("std::string helper() {", "helper")).toBeNull();
    expect(outOfLineOwner("static int helper(int x) {", "helper")).toBeNull();
  });
});

describe("C++ class-body declarations", () => {
  it("keeps pure virtual declarations as the abstract class's methods", () => {
    const classes = classesOf(`
class IPlayerRepo {
public:
    virtual ~IPlayerRepo() = default;
    virtual Player* find(int id) const = 0;
    virtual void save(const Player& u,
                      bool flush) = 0;
    virtual int count() const;
    int size() const { return 0; }
};
`);
    expect(classes).toHaveLength(1);
    const methods = classes[0]!.methods;
    expect(methods.map((m) => m.name)).toEqual(["find", "save", "size"]);
    expect(methods[0]).toMatchObject({ line: 5, endLine: 5, calls: [] });
    expect(methods[0]!.params.map((p) => p.name)).toEqual(["id"]);
    expect(methods[1]).toMatchObject({ line: 6, endLine: 7 });
  });

  it("leaves a C struct (no methods) and its function-pointer fields alone", () => {
    const a = extractWithRegex(`
typedef struct parser {
    int (*next)(struct parser* p);
    const char* src;
} parser_t;

int parse_all(parser_t* p) {
    return p->next(p);
}
`, "parser.h", "cpp");
    expect(a.classes.map((c) => [c.name, c.methods.length])).toEqual([["parser", 0]]);
    expect(a.functions.map((f) => f.name)).toEqual(["parse_all"]);
  });
});

describe("C++ signatures wrapped over several lines", () => {
  it("are methods when a body follows, never when a prototype ends with ;", () => {
    const cls = classesOf(`class FixtureService final : public league::FixtureService::Service
{
  Status GetFixture(ServerContext* context,
      const FixtureRequest* request,
      Fixture* reply) override
  {
    return Status::OK;
  }

  void Reschedule(int fixtureId,
      int days);
};`).find((c) => c.name === "FixtureService");
    expect(methodNames(cls)).toEqual(["GetFixture"]);
    expect(cls?.implements).toEqual(["league::FixtureService::Service"]);
  });
});

describe("C++ class namespaces", () => {
  it("records the namespace a class is declared in, and the one an out-of-line definition names", () => {
    const classes = classesOf(`
namespace league {
namespace home {
class Club {
 public:
  void play();
};
}
void home::Club::play() {
  sing();
}
}
void Away::Club::play() {
  boo();
}
namespace {
struct Ticket {
  void punch();
};
}
`);
    expect(classes.map((c) => [c.name, c.namespace ?? null, !!c.extension])).toEqual([
      ["Club", "league::home", false],
      // An unopened capitalized scope may be a class or a namespace: the file cannot tell, core places it.
      ["Away::Club", null, true],
      ["Ticket", null, false],
    ]);
    expect(methodNames(classes[0])).toEqual(["play"]);
  });
});

describe("C++ base clauses", () => {
  const basesOf = (src: string, name: string) => {
    const c = classesOf(src).find((x) => x.name === name)!;
    return [c.extends, c.implements];
  };

  it("reads every base, past access keywords, virtual and template arguments", () => {
    const src = `
template <typename T> class Tyre { public: void roll(); };
class Chassis { public: void weld(); };
class Engine { public: virtual void start() = 0; };
class Plugin { public: void load(); };
class Sedan : public Chassis, virtual public Engine, protected Tyre<int>, Plugin {
 public:
  void start() override;
};
class Racer : virtual Chassis { void go(); };
struct Plain : Chassis {};
`;
    expect(basesOf(src, "Sedan")).toEqual(["Chassis", ["Engine", "Tyre", "Plugin"]]);
    expect(basesOf(src, "Racer")).toEqual(["Chassis", []]);
    expect(basesOf(src, "Plain")).toEqual(["Chassis", []]);
  });

  it("never reads a base from the class body, and drops a template parameter", () => {
    const src = `
class Entity { public: void tick(); };
template <typename T>
class Crtp : public Tyre<Crtp<T>>, public T { void x(); };
`;
    expect(basesOf(src, "Entity")).toEqual([null, []]);
    expect(basesOf(src, "Crtp")).toEqual(["Tyre", []]);
  });

  it("reads a head wrapped over several lines", () => {
    const src = `
class Sedan
    : public Chassis,
      public Engine {
};
`;
    expect(basesOf(src, "Sedan")).toEqual(["Chassis", ["Engine"]]);
  });
});

describe("a struct named as a type is no declaration", () => {
  it("reads no class in a C prototype, a returned struct or a variable", () => {
    const src = "struct car *car_new(int wheels);\nstruct car make_car(void);\nstruct car spare;\nstruct car {\n    int wheels;\n};\n";
    expect(classesOf(src).map((c) => [c.name, c.line])).toEqual([["car", 4]]);
  });
});
