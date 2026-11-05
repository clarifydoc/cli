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

const boxH = `#pragma once
int box(int);
int kick(int);
`;
const boxCpp = `#include "box.h"

int box(int x) {
    return x + 1;
}

int kick(int x) {
    return x * 2;
}
`;
const pitCpp = `#include <functional>
#include "box.h"

int lambdaLocal() {
    auto box = [](int x) { return x; };
    return box(1);
}

int functionLocal() {
    std::function<int(int)> box = [](int x) { return x; };
    return box(2);
}

int paramCall(std::function<int(int)> kick) {
    return kick(3);
}

int pointerShadow() {
    int (*kick)(int) = &box;
    return kick(5);
}

int globalCall() {
    return box(6) + kick(7);
}

int blockLocal() {
    {
        auto kick = [](int x) { return x; };
        kick(8);
    }
    return kick(9);
}

int declaredHere() {
    int kick(int);
    return kick(10);
}
`;

const links = () => buildSymbolLinks([read(boxH, "src/box.h"), read(boxCpp, "src/box.cpp"), read(pitCpp, "src/pit.cpp")])
  .filter((l) => l.sourceFile === "src/pit.cpp")
  .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
  .sort();

describe("C++ locals and parameters a body calls", () => {
  it("never links a lambda, std::function, function-pointer local or parameter to the header's function of that name", () => {
    expect(links()).toEqual([
      "blockLocal@32 kick -> src/box.cpp::kick",
      "declaredHere@37 kick -> src/box.cpp::kick",
      "globalCall@24 box -> src/box.cpp::box",
      "globalCall@24 kick -> src/box.cpp::kick",
    ]);
  });

  it("marks the bound calls, each local to the end of its block", () => {
    const bound = readCpp(pitCpp).functions.map((f) => `${f.name}: ${f.calls.map((c) => `${c.name}@${c.line}${c.boundLocally ? " local" : ""}`).join(", ")}`);
    expect(bound).toEqual([
      "lambdaLocal: box@6 local",
      "functionLocal: box@11 local",
      "paramCall: kick@15 local",
      "pointerShadow: kick@20 local",
      "globalCall: box@24, kick@24",
      "blockLocal: kick@30 local, kick@32",
      "declaredHere: kick@37",
    ]);
  });
});

describe("C++ locals and parameters a body calls, on the line-scan reading (no-antlr)", () => {
  const plain = (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp"), projectId: "root" });
  const scanned = buildSymbolLinks([plain(boxH, "src/box.h"), plain(boxCpp, "src/box.cpp"), plain(pitCpp, "src/pit.cpp")])
    .filter((l) => l.sourceFile === "src/pit.cpp")
    .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();

  it("marks a name every call of which sits in its binding's scope, and links the rest", () => {
    expect(scanned).toEqual([
      "blockLocal kick -> src/box.cpp::kick",
      "declaredHere kick -> src/box.cpp::kick",
      "globalCall box -> src/box.cpp::box",
      "globalCall kick -> src/box.cpp::kick",
    ]);
  });
});
