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
    .map((l) => `${l.sourceFile}:${l.sourceSymbol} ${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
    .sort();

const header = (ns: string) => `#pragma once
namespace ${ns} {
class Club {
public:
  void play();
  void train();
};
}
`;

/** Two classes `Club`, one in namespace `Home` and one in `Away`; each defined out of line its own way. */
const twoClubs = {
  "src/home.h": header("Home"),
  // One definition written through the namespace the file opens, one inside it.
  "src/home.cpp": `#include "home.h"
void Home::Club::play() {
  sing();
}
namespace Home {
void Club::train() {
  run();
}
}
`,
  "src/away.h": header("Away"),
  // Written through a namespace this file never opens: the class is `Club` of `Away`, not a class `Away::Club`.
  "src/away.cpp": `#include "away.h"
void Away::Club::play() {
  boo();
}
void Away::Club::train() {
  walk();
}
`,
};

describe.each(Object.entries(readers))("C++ classes of one name in two namespaces (%s)", (_reader, read) => {
  it("matches a type written through its namespace on (namespace, name)", () => {
    expect(linksOf(read, {
      ...twoClubs,
      "src/match.cpp": `#include "away.h"
void match(Away::Club& a) {
  a.play();
}
`,
      "src/derby.cpp": `#include "home.h"
#include "away.h"
void derby(Home::Club* h) {
  h->train();
}
`,
    })).toEqual([
      "src/derby.cpp:derby h.train -> src/home.cpp:Club.train",
      "src/match.cpp:match a.play -> src/away.cpp:Club.play",
    ]);
  });

  it("completes a bare name from the enclosing namespace and `using namespace`, and refuses what neither decides", () => {
    expect(linksOf(read, {
      ...twoClubs,
      "src/visit.cpp": `#include "home.h"
#include "away.h"
using namespace Away;
void visit(Club& c) {
  c.play();
}
`,
      "src/coach.cpp": `#include "home.h"
#include "away.h"
namespace Home {
void coach(Club& c) {
  c.train();
}
}
`,
      // Both headers, no namespace open and none imported: which `Club` is not stated.
      "src/neutral.cpp": `#include "home.h"
#include "away.h"
void neutral(Club& c) {
  c.play();
}
`,
    })).toEqual([
      "src/coach.cpp:coach c.train -> src/home.cpp:Club.train",
      "src/visit.cpp:visit c.play -> src/away.cpp:Club.play",
    ]);
  });

  it("keeps a namespace written in lowercase on the declared type, relative to the namespaces around it", () => {
    const nested = (ns: string) => `#pragma once
namespace league {
namespace ${ns} {
class Club {
public:
  void play();
};
}
}
`;
    expect(linksOf(read, {
      "src/home.h": nested("home"),
      "src/away.h": nested("away"),
      "src/home.cpp": `#include "home.h"
namespace league {
namespace home {
void Club::play() {
  sing();
}
}
}
`,
      "src/away.cpp": `#include "away.h"
void league::away::Club::play() {
  boo();
}
`,
      "src/derby.cpp": `#include "home.h"
#include "away.h"
namespace league {
namespace home {
void derby(away::Club& rival, Club& own) {
  rival.play();
  own.play();
}
}
}
void friendly(const league::away::Club& guest) {
  guest.play();
}
`,
    })).toEqual([
      "src/derby.cpp:derby own.play -> src/home.cpp:Club.play",
      "src/derby.cpp:derby rival.play -> src/away.cpp:Club.play",
      "src/derby.cpp:friendly guest.play -> src/away.cpp:Club.play",
    ]);
  });

  it("tells two headers declaring `class Club` apart by what the caller includes", () => {
    const club = `#pragma once
class Club {
public:
  void play();
};
`;
    const body = (word: string) => `#include "club.h"
void Club::play() {
  ${word}();
}
`;
    expect(linksOf(read, {
      "src/home/club.h": club,
      "src/home/club.cpp": body("cheer"),
      "src/away/club.h": club,
      "src/away/club.cpp": body("jeer"),
      "src/match.cpp": `#include "home/club.h"
void kickoff(Club& c) {
  c.play();
}
`,
      // Through another header.
      "src/squad.h": `#pragma once
#include "away/club.h"
`,
      "src/visit.cpp": `#include "squad.h"
void travel(Club& c) {
  c.play();
}
`,
    })).toEqual([
      "src/match.cpp:kickoff c.play -> src/home/club.cpp:Club.play",
      "src/visit.cpp:travel c.play -> src/away/club.cpp:Club.play",
    ]);
  });
});

/** Two classes `Club` in different namespaces declared in ONE header, with a static `create` each. */
const oneHeader = {
  "src/clubs.h": `#pragma once
namespace Home {
class Club {
public:
  static Club *create() { return nullptr; }
  void kickoff() {}
};
}
namespace Away {
class Club {
public:
  static Club *create() { return nullptr; }
  void travel() {}
};
}
`,
  "src/season.cpp": `#include "clubs.h"
void replay() {
  Home::Club::create();
}
void other() {
  Away::Club::create();
}
void both() {
  Home::Club::create();
  Away::Club::create();
}
`,
};

describe.each(Object.entries(readers))("C++ classes of one name in two namespaces of one file (%s)", (_reader, read) => {
  it("names each by its path and joins a static call through that path to its own class", () => {
    expect(linksOf(read, oneHeader).filter((l) => l.includes("create"))).toEqual([
      "src/season.cpp:both Away::Club.create -> src/clubs.h:Away::Club.create",
      "src/season.cpp:both Home::Club.create -> src/clubs.h:Home::Club.create",
      "src/season.cpp:other Away::Club.create -> src/clubs.h:Away::Club.create",
      "src/season.cpp:replay Home::Club.create -> src/clubs.h:Home::Club.create",
    ]);
  });
});

describe.each(Object.entries(readers))("C++ using-directive in a header (%s)", (_reader, read) => {
  const files = {
    "src/league.h": "#pragma once\nnamespace League {\nint rank(int club);\n}\n",
    "src/league.cpp": "#include \"league.h\"\nnamespace League {\nint rank(int club) { return club; }\n}\n",
    "src/decoy.cpp": "namespace Other {\nint rank(int club) { return 0; }\n}\n",
    "src/prelude.h": "#pragma once\n#include \"league.h\"\nusing namespace League;\n",
    "src/scorer.cpp": "#include \"prelude.h\"\nint score(int c) { return rank(c); }\n",
    "src/bare.cpp": "#include \"league.h\"\nint bare(int c) { return rank(c); }\n",
  };
  it("applies to the files including that header, never to another namespace's namesake", () => {
    const links = linksOf(read, files).filter((l) => l.includes(" rank ->"));
    expect(links).toContain("src/scorer.cpp:score rank -> src/league.cpp:rank");
    expect(links.some((l) => l.includes("decoy.cpp"))).toBe(false);
  });
});
