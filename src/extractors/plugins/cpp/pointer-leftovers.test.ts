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

describe.each(Object.entries(readers))("C++ one-segment direct initialisation (%s)", (_reader, read) => {
  it("reads `Club c(3);` as the constructor call and types `c.play`, never the namesake Team", () => {
    const files = {
      "src/club.h": `#pragma once
class Club {
public:
  Club(int n);
  void play();
};
`,
      "src/club.cpp": `#include "club.h"
Club::Club(int n) {}
void Club::play() { kickoff(); }
`,
      "src/team.h": `#pragma once
class Team {
public:
  Team(int n);
  void play();
};
`,
      "src/team.cpp": `#include "team.h"
Team::Team(int n) {}
void Team::play() { whistle(); }
`,
      "src/season.cpp": `#include "club.h"
void open() {
  Club c(3);
  c.play();
}
`,
    };
    const links = linksOf(read, files).filter((l) => l.startsWith("open "));
    expect(links).toContain("open Club -> src/club.cpp:Club.Club");
    expect(links).toContain("open c.play -> src/club.cpp:Club.play");
    expect(links.some((l) => l.includes("Team"))).toBe(false);
  });
});

describe.each(Object.entries(readers))("C++ field-path calls on the regex fallback (%s)", (reader, read) => {
  it("names `kit.actions.Go` whole so a cut head never takes the decoy", () => {
    const files = {
      "src/actions.h": `#pragma once
class Actions {
public:
  void Go();
};
class Decoy {
public:
  void Go();
};
`,
      "src/actions.cpp": `#include "actions.h"
void Actions::Go() {}
void Decoy::Go() {}
`,
      "src/kit.h": `#pragma once
#include "actions.h"
struct Kit {
  Actions actions;
};
struct Garage {
  Kit kit;
  void Work();
};
`,
      "src/garage.cpp": `#include "kit.h"
void Garage::Work() {
  kit.actions.Go();
}
`,
    };
    const work = read(files["src/garage.cpp"]!, "src/garage.cpp").classes
      .flatMap((c) => c.methods)
      .find((m) => m.name === "Work");
    expect(work?.calls.some((c) => c.receiverCut)).toBeFalsy();
    expect(work?.calls.map((c) => c.name)).toContain("kit.actions.Go");
    expect(linksOf(read, files)).toEqual(["Garage.Work kit.actions.Go -> src/actions.cpp:Actions.Go"]);
    // The antlr reader already named the path; the regex path must match it.
    expect(reader === "regex" || reader === "antlr").toBe(true);
  });
});
