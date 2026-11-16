import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { readCpp } from "./antlr.js";
import { cppRangeBindings } from "./collection-element.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["cpp"]);
});

const readers = {
  antlr: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp", undefined, readCpp(src)), projectId: "root" }),
  regex: (src: string, rel: string): FileAnalysis => ({ ...extractWithRegex(src, rel, "cpp"), projectId: "root" }),
};

const model = {
  "src/club.h": "#pragma once\nclass Club { public: void play(); };\n",
  "src/club.cpp": '#include "club.h"\nvoid Club::play() { kickoff(); }\n',
  "src/team.h": "#pragma once\nclass Team { public: void play(); };\n",
  "src/team.cpp": '#include "team.h"\nvoid Team::play() { whistle(); }\n',
  "src/coach.h": "#pragma once\nclass Coach { public: void play(); };\n",
  "src/coach.cpp": '#include "coach.h"\nvoid Coach::play() { shout(); }\n',
};

describe("a container's pair or tuple members", () => {
  it("reads each member that is a value class", () => {
    expect(cppRangeBindings("std::vector<std::pair<Club, Team>>")).toEqual(["Club", "Team"]);
    expect(cppRangeBindings("const std::list<std::tuple<Club, int, Coach>>&")).toEqual(["Club", null, "Coach"]);
    expect(cppRangeBindings("std::map<int, Club>")).toEqual([null, "Club"]);
    expect(cppRangeBindings("std::vector<Club>")).toBeNull();
    expect(cppRangeBindings("std::vector<std::pair<Club*, Team>>")).toEqual([null, "Team"]);
  });
});

describe.each(Object.entries(readers))("C++ structured bindings over a vector of pairs (%s)", (_reader, read) => {
  it("types each name by its member of the pair or tuple, in a local and in a parameter", () => {
    const links = buildSymbolLinks(Object.entries({
      ...model,
      "src/season.cpp": `#include "club.h"
#include "team.h"
#include "coach.h"
#include <vector>
#include <utility>
#include <tuple>
void local() {
  std::vector<std::pair<Club, Team>> rows;
  for (auto& [a, b] : rows) {
    a.play();
    b.play();
  }
}
void param(const std::vector<std::tuple<Team, int, Coach>>& rows) {
  for (const auto& [t, n, c] : rows) {
    t.play();
    c.play();
  }
}
`,
    }).map(([rel, src]) => read(src, rel)))
      .filter((l) => l.sourceFile === "src/season.cpp")
      .map((l) => `${l.sourceSymbol} ${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "local a.play -> src/club.cpp:Club.play",
      "local b.play -> src/team.cpp:Team.play",
      "param c.play -> src/coach.cpp:Coach.play",
      "param t.play -> src/team.cpp:Team.play",
    ]);
  });
});
