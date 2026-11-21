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

const links = (files: Record<string, string>, from: string): string[] =>
  buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
    .filter((l) => l.sourceFile === from)
    .map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
    .sort();

const club = {
  "src/league/club.h": `#pragma once\nclass Club {\npublic:\n  void kick();\n};\n`,
  "src/league/club.cpp": `#include "club.h"\nvoid Club::kick() {\n  strike();\n}\n`,
  // A namesake in a folder the caller never includes.
  "src/other/club.h": `#pragma once\nclass Club {\npublic:\n  void kick();\n};\n`,
};

describe("a forward declaration beside the class that has a body", () => {
  it("is never the class a receiver means, when the file declares it forward after the include", () => {
    const found = links({
      ...club,
      "src/league/use.cpp": `#include "club.h"\nclass Club;\nvoid go(Club* c) {\n  c->kick();\n}\n`,
    }, "src/league/use.cpp");
    expect(found).toEqual(["c.kick -> src/league/club.cpp:Club.kick"]);
  });
  it("does not tie with the body when a second header only forward-declares it", () => {
    const found = links({
      ...club,
      "src/league/fwd.h": `#pragma once\nclass Club;\n`,
      "src/league/use.cpp": `#include "fwd.h"\n#include "club.h"\nvoid go(Club* c) {\n  c->kick();\n}\n`,
    }, "src/league/use.cpp");
    expect(found).toEqual(["c.kick -> src/league/club.cpp:Club.kick"]);
  });
  it("finds nothing where no included header has the body (the namesake outside is no answer)", () => {
    const found = links({
      ...club,
      "src/league/use.cpp": `class Club;\nvoid go(Club* c) {\n  c->kick();\n}\n`,
    }, "src/league/use.cpp");
    expect(found.filter((l) => l.includes("src/other/"))).toEqual([]);
  });
});
