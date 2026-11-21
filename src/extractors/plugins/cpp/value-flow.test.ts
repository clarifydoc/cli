import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readCpp } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const read = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" });

const clubCpp = `#include <functional>
#include <vector>

void onGoal(int n) {}
void onKick(int n) {}

class Club {
public:
    Club() : later_(&Club::save) {}
    void save() {}
    void arm() { onSave_ = onKick; }
    void fire() { onSave_(); }
    void hook() { hook_ = [this] { save(); }; }
    void ring() { hook_(); }
    void bindIt() { bound_ = std::bind(&Club::save, this); }
    void runBound() { bound_(); }
    void viaLocal() {
        std::function<void()> g = [this] { save(); };
        g();
    }
private:
    std::function<void()> onSave_;
    std::function<void()> hook_;
    std::function<void()> bound_;
    std::function<void()> later_;
};

class Rival {
public:
    void rivalSave() {}
    void arm() { onSave_ = rivalSave; }
    void fire() { onSave_(); }
private:
    std::function<void()> onSave_;
};

void wrap(std::function<void(int)> f) { f(1); }
std::function<void(int)> makeCb() { return onGoal; }

void use() {
    wrap(onKick);
    auto f = makeCb();
    f(3);
    std::vector<std::function<void(int)>> hs;
    hs.push_back(onGoal);
    for (auto& h : hs) h(2);
    std::function<void(int)> copy = onKick;
    std::function<void(int)> again = copy;
    wrap(again);
}
`;

// A namesake in another translation unit never takes a call.
const decoyCpp = `static void onKick(int n) {}
static void onGoal(int n) {}
void unrelated() { onKick(1); onGoal(2); }
`;

function links(): string[] {
  return buildSymbolLinks([read(clubCpp, "src/club.cpp"), read(decoyCpp, "src/decoy.cpp")])
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("C++ function values followed to the call that runs them", () => {
  const found = links();
  it("a function handed to a wrapper that calls its parameter", () => {
    expect(found).toContain("wrap@37 f -> src/club.cpp::onKick");
  });
  it("a std::function field set in one method and run in another", () => {
    expect(found).toContain("Club.fire@12 onSave_ -> src/club.cpp::onKick");
  });
  it("fields are per class: another class's field of the same name stays its own", () => {
    expect(found).toContain("Rival.fire@32 onSave_ -> src/club.cpp::Rival.rivalSave");
    expect(found).not.toContain("Club.fire@12 onSave_ -> src/club.cpp::Rival.rivalSave");
    expect(found).not.toContain("Rival.fire@32 onSave_ -> src/club.cpp::onKick");
  });
  it("a lambda stored in a field runs what its body calls", () => {
    expect(found).toContain("Club.ring@14 hook_ -> src/club.cpp::Club.save");
  });
  it("std::bind of a member function stored in a field", () => {
    expect(found).toContain("Club.runBound@16 bound_ -> src/club.cpp::Club.save");
  });
  it("a lambda held in a local", () => {
    expect(found).toContain("Club.viaLocal@19 g -> src/club.cpp::Club.save");
  });
  it("a function returned from a factory", () => {
    expect(found).toContain("use@43 f -> src/club.cpp::onGoal");
  });
  it("a vector of handlers run by element", () => {
    expect(found).toContain("use@46 h -> src/club.cpp::onGoal");
  });
  it("a std::function copied and passed on", () => {
    expect(found).toContain("wrap@37 f -> src/club.cpp::onKick");
  });
  it("never reaches a namesake in another translation unit", () => {
    expect(found.filter((l) => l.includes("src/decoy.cpp"))).toEqual([]);
  });
});

// A constructor whose initializer list holds a templated base and a brace initializer: its body is still read.
const ctorCpp = `#include <functional>
void onKick(int n) {}
template <class T> struct Base { Base(T) {} };
class Club : public Base<int> {
public:
    Club(int n) : Base<int>(n), n_{3} { cb_ = onKick; }
    void fire() { cb_(1); }
private:
    int n_;
    std::function<void(int)> cb_;
};
`;

describe("C++ constructors", () => {
  it("reads the body after a templated base and a brace initializer", () => {
    const found = buildSymbolLinks([read(ctorCpp, "src/ctor.cpp")])
      .filter((l) => l.strategy === "value-flow")
      .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);
    expect(found).toEqual(["Club.fire cb_ -> onKick"]);
  });
});


// A held lambda states every name its body calls; core counts the project functions among them.
const lambdaCapCpp = (n: number): string => {
  const defs = ["kickOff", "halfTime", "fullTime", "extraTime", "penalties"].slice(0, n);
  return `#include <functional>
#include <algorithm>
${defs.map((d) => `void ${d}() {}`).join("\n")}

class Referee {
public:
    void arm() {
        hook_ = [this] {
            printf("go");
            std::sort(v_.begin(), v_.end());
            log_line("x");
            ${defs.map((d) => `${d}();`).join("\n            ")}
        };
    }
    void blow() { hook_(); }
private:
    std::function<void()> hook_;
};
`;
};
const lambdaDecoyCpp = `static void kickOff() {}
static void halfTime() {}
static void fullTime() {}
static void extraTime() {}
static void penalties() {}
void unrelated() { kickOff(); halfTime(); fullTime(); extraTime(); penalties(); }
`;
const lambdaLinks = (n: number): string[] =>
  buildSymbolLinks([read(lambdaCapCpp(n), "src/referee.cpp"), read(lambdaDecoyCpp, "src/decoy.cpp")])
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();

describe("C++ held lambda cap is counted by core over project functions", () => {
  it("four project functions among library calls all link", () => {
    const found = lambdaLinks(4);
    for (const d of ["kickOff", "halfTime", "fullTime", "extraTime"]) expect(found).toContain(`hook_ -> src/referee.cpp::${d}`);
    expect(found.filter((l) => l.includes("src/decoy.cpp"))).toEqual([]);
  });
  it("five project functions link nothing", () => {
    const found = lambdaLinks(5);
    expect(found.filter((l) => l.startsWith("hook_"))).toEqual([]);
    expect(found.filter((l) => l.includes("src/decoy.cpp"))).toEqual([]);
  });
});

// A function-typed field a header declares, filled in one file and run in another.
const carHeader = `#pragma once
typedef void (*signal_cb)(int);
#include <functional>
struct Car {
  void (*on_fire)(int);
  std::function<void(int)> on_sign;
  int on_count;
  void on_start();
  void run();
  signal_cb on_done;
};
struct Garage {
  void on_fire(int n);
  int on_sign;
};
`;
const setupCpp = `#include "car.h"
void warmUp(int n) {}
void signIn(int n) {}
void prepare(Car& c) { c.on_fire = warmUp; c.on_sign = signIn; c.on_done = warmUp; }
`;
const runCpp = `#include "car.h"
void runCar(Car& c) { c.on_fire(3); c.on_sign(4); c.on_start(); c.on_count(5); c.on_done(9); }
void runPtr(Car* c) { c->on_fire(6); }
void Car::run() { this->on_fire(10); }
void runGarage(Garage& g) { g.on_fire(7); g.on_sign(8); }
`;

describe("C++ function-typed fields declared in a header", () => {
  const header = read(carHeader, "src/car.h");
  it("records a function pointer and a std::function field as callable properties", () => {
    const car = header.classes.find((c) => c.name === "Car")!;
    expect(car.properties.filter((p) => p.callable).map((p) => p.name).sort()).toEqual(["on_done", "on_fire", "on_sign"]);
    expect(car.properties.find((p) => p.name === "on_count")?.callable).toBeUndefined();
  });
  const found = buildSymbolLinks([header, read(setupCpp, "src/setup.cpp"), read(runCpp, "src/run.cpp")])
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetSymbol}`)
    .sort();
  it("a field set in one file reaches the call that runs it in another", () => {
    expect(found).toContain("runCar@2 c.on_fire -> warmUp");
    expect(found).toContain("runCar@2 c.on_sign -> signIn");
    expect(found).toContain("runPtr@3 c.on_fire -> warmUp");
    expect(found).toContain("runCar@2 c.on_done -> warmUp");
    expect(found).toContain("Car.run@4 this.on_fire -> warmUp");
  });
  it("a method of the field's name, a data field and another class's member never link", () => {
    expect(found.filter((l) => l.startsWith("runGarage"))).toEqual([]);
    expect(found.filter((l) => l.includes("c.on_start") || l.includes("c.on_count"))).toEqual([]);
  });
});

// A callback stored in a field named like an accessor, on a base declared in its own header; and a namesake class whose
// member of that name is a method in another sub-project, which an invoke must never be taken from.
describe("C++ callable fields: no name list, no namesake across sub-projects", () => {
  const inProject = (a: FileAnalysis, projectId: string): FileAnalysis => ({ ...a, projectId });
  const baseH = `#pragma once
#include <functional>
struct Base { std::function<void()> value; std::function<void()> run; };
`;
  const derivedH = `#pragma once
#include "base.h"
struct Derived : Base { int n; };
`;
  const wireCpp = `#include "derived.h"
void go() {}
void wire(Derived& d) { d.value = go; }
`;
  const useCpp = `#include "derived.h"
void drive(Derived& d) { d.value(); }
`;
  const otherH = `#pragma once
struct Derived { void value(); };
`;
  const otherCpp = `#include "derived.h"
void Derived::value() {}
void stop(Derived& d) { d.value(); }
`;
  const found = buildSymbolLinks([
    inProject(read(baseH, "a/base.h"), "a"), inProject(read(derivedH, "a/derived.h"), "a"),
    inProject(read(wireCpp, "a/wire.cpp"), "a"), inProject(read(useCpp, "a/use.cpp"), "a"),
    inProject(read(otherH, "b/derived.h"), "b"), inProject(read(otherCpp, "b/derived.cpp"), "b"),
  ]).map((l) => `${l.strategy} ${l.sourceSymbol} ${l.callName} -> ${l.targetSymbol}`);
  it("runs a callback stored in a field named `value`, declared on a base", () => {
    expect(found).toContain("value-flow drive d.value -> go");
  });
  it("keeps the method of the namesake class in the other sub-project linked, not taken as an invoke", () => {
    expect(found.filter((l) => l.startsWith("value-flow stop"))).toEqual([]);
    expect(found.some((l) => l.includes("stop d.value -> Derived.value"))).toBe(true);
  });
});

// A header's class declares a callback field in a header named unlike the class; a namesake class elsewhere, which the
// caller never includes, has methods of the same names defined out of line.
describe("C++ member calls: a namesake class outside the include closure never takes the call", () => {
  const typesH = `#pragma once
#include <functional>
class Squad {
public:
  std::function<void()> onGoal;
  void cheer();
};
`;
  const typesCpp = `#include "club/types.h"
void Squad::cheer() {}
`;
  const decoyH = `#pragma once
class Squad {
public:
  void onGoal();
  void rest();
  void cheer();
};
`;
  const decoyCpp = `#include "decoy.h"
void Squad::onGoal() {}
void Squad::rest() {}
void Squad::cheer() {}
`;
  const wireCpp = `#include "club/types.h"
void celebrate() {}
void wire(Squad& squad) { squad.onGoal = celebrate; }
`;
  const mainCpp = `#include "club/types.h"
void play(Squad& squad) {
  squad.onGoal();
  squad.rest();
  squad.cheer();
}
`;
  const found = buildSymbolLinks([
    read(typesH, "club/types.h"), read(typesCpp, "club/types.cpp"), read(decoyH, "other/decoy.h"), read(decoyCpp, "other/decoy.cpp"),
    read(wireCpp, "wire.cpp"), read(mainCpp, "main.cpp"),
  ]).filter((l) => l.sourceSymbol === "play").map((l) => `${l.strategy} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  it("a member only the other class defines does not link to it", () => {
    expect(found.filter((l) => l.includes("other/decoy"))).toEqual([]);
  });
  it("a method the included class defines out of line keeps its link", () => {
    expect(found).toContain("injection squad.cheer -> club/types.cpp::Squad.cheer");
  });
});

// The class's header is named unlike the class (`club/types.h` declares `Squad`): core finds the class through the
// caller's include closure and reads the member call as the run of what another file stored in the field.
describe("C++ callable fields: the class's header need not be named for it", () => {
  const typesH = `#pragma once
#include <functional>
class Squad {
public:
  std::function<void()> onGoal;
  void cheer();
};
`;
  const decoyH = `#pragma once
class Squad {
public:
  void onGoal();
};
`;
  const decoyCpp = `#include "decoy.h"
void Squad::onGoal() {}
`;
  const wireCpp = `#include "club/types.h"
void celebrate() {}
void wire(Squad& squad) { squad.onGoal = celebrate; }
`;
  const mainCpp = `#include "club/types.h"
void play(Squad& squad) { squad.onGoal(); }
void rally() { Squad s; s.onGoal(); }
`;
  const otherCpp = `#include "other/decoy.h"
void rest(Squad& squad) { squad.onGoal(); }
`;
  const found = buildSymbolLinks([
    read(typesH, "club/types.h"), read(decoyH, "other/decoy.h"), read(decoyCpp, "other/decoy.cpp"),
    read(wireCpp, "wire.cpp"), read(mainCpp, "main.cpp"), read(otherCpp, "other/rest.cpp"),
  ]).map((l) => `${l.strategy} ${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  it("the call runs what another file stored in the field", () => {
    expect(found).toContain("value-flow play squad.onGoal -> wire.cpp::celebrate");
  });
  it("no namesake takes the call, and the namesake's own caller keeps its method", () => {
    expect(found.filter((l) => l.startsWith("injection play") || l.startsWith("injection rally"))).toEqual([]);
    expect(found).toContain("injection rest squad.onGoal -> other/decoy.cpp::Squad.onGoal");
    expect(found.filter((l) => l.startsWith("value-flow rest"))).toEqual([]);
  });
});
