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
