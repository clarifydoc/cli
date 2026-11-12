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

