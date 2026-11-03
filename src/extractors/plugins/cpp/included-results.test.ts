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

describe.each(Object.entries(readers))("C++ locals typed by an included function's result (%s)", (_reader, read) => {
  it("types `auto c = makeCar();` by the return type of the function the include declares", () => {
    const files: Record<string, string> = {
      "src/car.h": `#pragma once
class Car {
public:
  void drive();
};
Car makeCar();
`,
      "src/car.cpp": `#include "car.h"
void Car::drive() {
  ignite();
}
Car makeCar() {
  return Car();
}
`,
      // A second `drive`: the factory's return type, not the method's name, decides which.
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
      "src/garage.cpp": `#include "car.h"
void go() {
  auto c = makeCar();
  c.drive();
}
`,
    };
    const links = buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
      .filter((l) => l.sourceFile === "src/garage.cpp")
      .map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
      .sort();
    expect(links).toEqual(["c.drive -> src/car.cpp:Car.drive", "makeCar -> src/car.cpp:makeCar"]);
  });
});
