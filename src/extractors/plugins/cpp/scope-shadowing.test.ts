import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readCpp } from "./antlr.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const readers = {
  antlr: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" }),
  regex: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp"), projectId: "root" }),
};

const linksOf = (read: (src: string, rel: string) => FileAnalysis, files: Record<string, string>) =>
  buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
    .sort();

describe.each(Object.entries(readers))("C++ names scoped away from a namesake (%s)", (_reader, read) => {
  describe("a block-local alias", () => {
    const base = {
      "src/cars.h": `#pragma once\nstruct Coupe { void drive(); };\nstruct Estate { void drive(); };\n`,
      "src/cars.cpp": `#include "cars.h"\nvoid Coupe::drive() {}\nvoid Estate::drive() {}\n`,
    };

    it("shadows the file-level alias of its name inside its block only", () => {
      expect(linksOf(read, {
        ...base,
        "src/garage.cpp": `#include "cars.h"
using Ride = Coupe;
void park() {
  using Ride = Estate;
  Ride inner;
  inner.drive();
}
void outer() {
  Ride o;
  o.drive();
}
void typedefd() {
  typedef Estate Ride;
  Ride t;
  t.drive();
}
void nested() {
  {
    using Ride = Estate;
    Ride a;
    a.drive();
  }
  Ride b;
  b.drive();
}
`,
      }).filter((l) => !l.startsWith("Coupe") && !l.startsWith("Estate"))).toEqual([
        "nested a.drive -> src/cars.cpp:Estate.drive",
        "nested b.drive -> src/cars.cpp:Coupe.drive",
        "outer o.drive -> src/cars.cpp:Coupe.drive",
        "park inner.drive -> src/cars.cpp:Estate.drive",
        "typedefd t.drive -> src/cars.cpp:Estate.drive",
      ]);
    });
  });

  describe("two headers declaring one class name", () => {
    const base = {
      "src/home/club.h": `#pragma once\nclass Club { public: void sign(); };\n`,
      "src/home/club.cpp": `#include "club.h"\nvoid Club::sign() {}\n`,
      "src/away/club.h": `#pragma once\nclass Club { public: void sign(); };\n`,
      "src/away/club.cpp": `#include "club.h"\nvoid Club::sign() {}\n`,
    };
    const same = {
      "src/one.h": `#pragma once\nclass Squad { public: void pick(); };\n`,
      "src/one.cpp": `#include "one.h"\nvoid Squad::pick() {}\n`,
      "src/two.h": `#pragma once\nclass Squad { public: void pick(); };\n`,
      "src/two.cpp": `#include "two.h"\nvoid Squad::pick() {}\n`,
    };

    it("links the one an include names, and nothing when none or both are included", () => {
      expect(linksOf(read, {
        ...same,
        "src/none.cpp": `void none(Squad* s) { s->pick(); }\n`,
        "src/both.cpp": `#include "one.h"\n#include "two.h"\nvoid both(Squad* s) { s->pick(); }\n`,
        "src/only.cpp": `#include "two.h"\nvoid only(Squad* s) { s->pick(); }\n`,
      })).toEqual([
        "only s.pick -> src/two.cpp:Squad.pick",
      ]);
    });

    it("keeps a class split over its header and source one type, in other directories too", () => {
      expect(linksOf(read, {
        ...base,
        "src/match/play.cpp": `#include "../home/club.h"\nvoid play(Club* c) { c->sign(); }\n`,
        "src/match/idle.cpp": `void idle(Club* c) { c->sign(); }\n`,
      })).toEqual([
        "play c.sign -> src/home/club.cpp:Club.sign",
      ]);
    });
  });

  describe("an anonymous-namespace class beside a global one", () => {
    const base = {
      "src/crew.h": `#pragma once\nclass Crew { public: void line(); };\n`,
      "src/crew.cpp": `#include "crew.h"\nvoid Crew::line() {}\n`,
    };

    it("is its own file's alone: other files reach the global class", () => {
      expect(linksOf(read, {
        ...base,
        "src/pit.cpp": `#include "crew.h"
namespace {
class Crew { public: void line(); };
void Crew::line() {}
}
void inPit() { Crew c; c.line(); }
`,
        "src/track.cpp": `#include "crew.h"\nvoid onTrack() { Crew c; c.line(); }\n`,
      })).toEqual([
        "inPit c.line -> src/pit.cpp:Crew.line",
        "onTrack c.line -> src/crew.cpp:Crew.line",
      ]);
    });

    it("never answers another file that names the type with no include", () => {
      expect(linksOf(read, {
        "src/pit.cpp": `namespace {\nclass Crew { public: void line(); };\nvoid Crew::line() {}\n}\nvoid inPit() { Crew c; c.line(); }\n`,
        "src/track.cpp": `void onTrack() { Crew c; c.line(); }\n`,
      }).filter((l) => l.startsWith("on"))).toEqual([]);
    });
  });

  describe("members typed by an anonymous-namespace class", () => {
    const unit = (file: string, word: string) => `namespace {
class Valve { public: bool open(); void ${word}() {} };
}
class Pit${file} {
 public:
  ~Pit${file}() { valve_->${word}(); }
 private:
  Valve* valve_;
};
`;

    it("types a field by its own file's class, never another file's namesake", () => {
      expect(linksOf(read, {
        "src/pit_a.cc": unit("A", "shut"),
        "src/pit_b.cc": unit("B", "seal"),
      }).filter((l) => l.startsWith("PitA") || l.startsWith("PitB"))).toEqual([
        "PitA.~PitA valve_.shut -> src/pit_a.cc:Valve.shut",
        "PitB.~PitB valve_.seal -> src/pit_b.cc:Valve.seal",
      ]);
    });
  });

  describe("two headers one name, one reached through a further include", () => {
    it("links a member to the declaration the include closure reaches; an unincluded namesake never blocks it", () => {
      expect(linksOf(read, {
        "src/port/port_example.h": `#pragma once\nnamespace port {\nclass Gate { public: void wait() {} };\n}\n`,
        "src/port/port_impl.h": `#pragma once\nnamespace port {\nclass Gate { public: void wait() {} };\n}\n`,
        "src/port/port.h": `#pragma once\n#include "port/port_impl.h"\n`,
        "src/db/engine.cc": `#include "port/port.h"
class Engine {
 public:
  void run() { gate_.wait(); }
 private:
  port::Gate gate_;
};
`,
      }).filter((l) => l.startsWith("Engine"))).toEqual([
        "Engine.run gate_.wait -> src/port/port_impl.h:Gate.wait",
      ]);
    });

    it("links a member to the caller's own declaration, and to the one header its includes reach", () => {
      expect(linksOf(read, {
        "src/kit/shirt.h": `#pragma once
template <typename T>
struct Printer {
  void stitch() {}
};
struct Shirt {
  void wear() { printer_.stitch(); }
  Printer<int> printer_;
};
`,
        "src/kit/shorts.h": `#pragma once
template <typename T>
struct Printer {
  void stitch() {}
};
`,
        "src/kit/socks.h": `#pragma once
#include "shirt.h"
struct Socks {
  void wear() { printer_.stitch(); }
  Printer<long> printer_;
};
`,
      }).filter((l) => l.startsWith("Shirt") || l.startsWith("Socks"))).toEqual([
        "Shirt.wear printer_.stitch -> src/kit/shirt.h:Printer.stitch",
        "Socks.wear printer_.stitch -> src/kit/shirt.h:Printer.stitch",
      ]);
    });
  });
});
