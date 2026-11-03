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

const partsH = `#pragma once
class Engine {
 public:
  bool IsOk();
  void Rev();
};
class Brake {
 public:
  bool IsOk();
  void Bleed();
};
`;
const partsCpp = `#include "parts.h"
bool Engine::IsOk() { return true; }
void Engine::Rev() {}
bool Brake::IsOk() { return false; }
void Brake::Bleed() {}
`;
const checkCpp = `#include "parts.h"

bool Shadow(Engine T) {
  {
    Brake T;
    return T.IsOk();
  }
}

bool Plain(Engine T) {
  return T.IsOk();
}
`;

describe.each(Object.entries(readers))("C++ local shadowing a parameter (%s)", (_, read) => {
  it("never types a call on the local by the parameter it shadows", () => {
    const links = buildSymbolLinks([read(partsH, "src/parts.h"), read(partsCpp, "src/parts.cpp"), read(checkCpp, "src/check.cpp")])
      .filter((l) => l.sourceFile === "src/check.cpp")
      .map((l) => `${l.sourceSymbol}@${l.sourceLine} ${l.callName} -> ${l.targetSymbol}`);
    expect(links).toEqual(["Plain@11 T.IsOk -> Engine.IsOk"]);
  });
});
