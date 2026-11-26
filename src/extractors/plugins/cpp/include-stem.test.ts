import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["c", "cpp"]);
});

const read = (src: string, rel: string, language: "c" | "cpp" = "cpp"): FileAnalysis => ({ ...extractWithRegex(src, rel, language), projectId: "root" });

// An include binds no name: the header's stem is its own fact, `ImportInfo.includeStem`, and `specifiers` stays empty.
describe("an include states its header's stem and no binding", () => {
  it.each(["c", "cpp"] as const)("%s: the stem is a fact of the import, the specifiers are empty", (language) => {
    const a = read('#include "club_ops.h"\n#include <league/Club.hpp>\n#include <vector>\n', "src/a.c", language);
    expect(a.imports.map((i) => ({ source: i.source, specifiers: i.specifiers, includeStem: i.includeStem }))).toEqual([
      { source: "club_ops.h", specifiers: [], includeStem: "club_ops" },
      { source: "league/Club.hpp", specifiers: [], includeStem: "Club" },
      { source: "vector", specifiers: [], includeStem: "vector" },
    ]);
  });

  it("a using-declaration still binds its name", () => {
    const a = read("using league::Club;\n", "src/a.cpp");
    expect(a.imports.map((i) => ({ specifiers: i.specifiers, includeStem: i.includeStem }))).toEqual([{ specifiers: ["Club"], includeStem: undefined }]);
  });
});

// `league.h` declares `namespace league`: the stem is the qualifier of what the header declares.
const leagueHeader = `namespace league {
int tally(int goals);
}
`;
const leagueImpl = `#include "league.h"
namespace league {
int tally(int goals) { return goals; }
}
`;
const caller = `#include "league.h"
int run(int goals) { return league::tally(goals); }
`;
// A namesake header of another folder, never included by the caller.
const decoyHeader = `namespace league {
int tally(int goals);
}
`;
const decoyImpl = `#include "league.h"
namespace league {
int tally(int goals) { return goals + 1; }
}
`;

describe("a header named like what it declares", () => {
  const links = (extra: FileAnalysis[] = []) => buildSymbolLinks([
    read(leagueHeader, "src/league.h"),
    read(leagueImpl, "src/league.cpp"),
    read(caller, "src/run.cpp"),
    ...extra,
  ]).filter((l) => l.sourceFile === "src/run.cpp").map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}::${l.targetSymbol} (${l.strategy})`).sort();

  it("still resolves `ns::f` through the include of the header", () => {
    expect(links().some((l) => l.startsWith("run league.tally -> src/") && l.includes("::tally"))).toBe(true);
  });

  it("never takes the namesake header of a folder the caller does not include", () => {
    const found = links([read(decoyHeader, "src/decoy/league.h"), read(decoyImpl, "src/decoy/league.cpp")]);
    expect(found.some((l) => l.includes("src/decoy/"))).toBe(false);
  });
});

// `Club.h` declares `class Club`: the include reads as a reference to it, with no specifier stated.
describe("a header named like its class", () => {
  it("links the includer to the class by the stem, as a reference", () => {
    const found = buildSymbolLinks([
      read("class Club {\n public:\n  int wins();\n};\n", "src/Club.h"),
      read('#include "Club.h"\nint total(Club* c) { return c->wins(); }\n', "src/total.cpp"),
    ]).filter((l) => l.strategy === "reference").map((l) => `${l.sourceFile} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(found).toContain("src/total.cpp -> src/Club.h::Club");
  });

  it("never lets the stem hide a struct of the name the header declares", () => {
    const header = read("struct club_ops { int (*scout)(int); };\n", "src/club_ops.h", "c");
    const user = read('#include "club_ops.h"\nint run(struct club_ops *o) { return o->scout(1); }\n', "src/run.c", "c");
    expect(user.imports[0]!.specifiers).toEqual([]);
    expect(header.classes.map((c) => c.name)).toContain("club_ops");
  });
});
