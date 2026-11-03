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

const cars = {
  "src/car.h": `#pragma once
#include <memory>
class Car {
public:
  void drive();
};
using Ride = Car;
typedef Car Motor;
using CarPtr = std::shared_ptr<Car>;
`,
  "src/car.cpp": `#include "car.h"
void Car::drive() {
  ignite();
}
`,
  // A second `drive`: the alias, not the method's name, decides which.
  "src/bike.h": `#pragma once
class Bike {
public:
  void drive();
};
`,
  "src/bike.cpp": `#include "bike.h"
void Bike::drive() {
  pedal();
}
`,
};

describe.each(Object.entries(readers))("C++ type aliases (%s)", (_reader, read) => {
  it("types a receiver declared with a `using` or `typedef` alias by the class it names", () => {
    expect(linksOf(read, {
      ...cars,
      "src/garage.cpp": `#include "car.h"
void ride(Ride& r) {
  r.drive();
}
void motor(Motor* m) {
  m->drive();
}
void owned(CarPtr p) {
  p->drive();
}
`,
    })).toEqual([
      "motor m.drive -> src/car.cpp:Car.drive",
      "owned p.drive -> src/car.cpp:Car.drive",
      "ride r.drive -> src/car.cpp:Car.drive",
    ]);
  });

  it("follows an alias used as a scope, and constructs a nested class named through its owner", () => {
    const iterator = (owner: string) => `#pragma once
class ${owner} {
public:
  class Iterator {
  public:
    Iterator(int at);
    void next();
  };
};
`;
    expect(linksOf(read, {
      "src/table.h": `${iterator("Table")}typedef Table League;
`,
      "src/table.cpp": `#include "table.h"
Table::Iterator::Iterator(int at) {
  seek(at);
}
void Table::Iterator::next() {
  step();
}
`,
      "src/chart.h": iterator("Chart"),
      "src/chart.cpp": `#include "chart.h"
Chart::Iterator::Iterator(int at) {
  climb(at);
}
void Chart::Iterator::next() {
  climb(1);
}
`,
      "src/standings.cpp": `#include "table.h"
void walk(League::Iterator& it) {
  it.next();
}
void open() {
  Table::Iterator* it = new Table::Iterator(3);
  it->next();
}
`,
    })).toEqual([
      "open Table.Iterator -> src/table.cpp:Table::Iterator.Iterator",
      "open it.next -> src/table.cpp:Table::Iterator.next",
      "walk it.next -> src/table.cpp:Table::Iterator.next",
    ]);
  });

  it("takes the class its own file declares over another file's of the same name", () => {
    // Two source files, one per platform, each declaring its own `Pit` and an alias of it.
    const pit = (word: string, alias: string) => `namespace {
class Pit {
 public:
  static void stop() {
    ${word}();
  }
  void wave() {
    ${word}();
  }
};
using ${alias} = Pit;
}
void race() {
  ${alias}::stop();
  static ${alias} crew;
  crew.wave();
}
`;
    expect(linksOf(read, {
      "src/pit_posix.cc": pit("brake", "PosixPit"),
      "src/pit_windows.cc": pit("coast", "WindowsPit"),
    })).toEqual([
      "race PosixPit.stop -> src/pit_posix.cc:Pit.stop",
      "race WindowsPit.stop -> src/pit_windows.cc:Pit.stop",
      "race crew.wave -> src/pit_posix.cc:Pit.wave",
      "race crew.wave -> src/pit_windows.cc:Pit.wave",
    ]);
  });
});
