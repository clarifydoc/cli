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

const table = (owner: string, word: string) => `#pragma once
class ${owner} {
public:
  static ${owner}* make();
  class Iterator {
  public:
    Iterator(int at);
    void next();
  };
};
`;
const body = (owner: string, word: string) => `#include "${owner.toLowerCase()}.h"
${owner}* ${owner}::make() {
  ${word}();
  return nullptr;
}
${owner}::Iterator::Iterator(int at) {
  ${word}(at);
}
void ${owner}::Iterator::next() {
  ${word}(1);
}
`;

describe.each(Object.entries(readers))("C++ alias used as a scope (%s)", (_reader, read) => {
  const project = {
    "src/table.h": table("Table", "seek"),
    "src/table.cpp": body("Table", "seek"),
    "src/chart.h": table("Chart", "climb"),
    "src/chart.cpp": body("Chart", "climb"),
  };

  it("joins `Alias::make()` and `Alias::Iterator` to the class the alias names, never a namesake's", () => {
    expect(linksOf(read, {
      ...project,
      "src/standings.cpp": `#include "table.h"
#include "chart.h"
using Rank = Table;
void walk() {
  Rank* t = Rank::make();
  Rank::Iterator* it = new Rank::Iterator(2);
  it->next();
}
`,
    }).filter((l) => l.startsWith("walk"))).toEqual([
      "walk Rank.Iterator -> src/table.cpp:Table::Iterator.Iterator",
      "walk Rank.make -> src/table.cpp:Table.make",
      "walk it.next -> src/table.cpp:Table::Iterator.next",
    ]);
  });

  it("joins `new Outer::Inner(…)` to the nested class by its path", () => {
    expect(linksOf(read, {
      ...project,
      "src/standings.cpp": `#include "table.h"
#include "chart.h"
void open() {
  Table::Iterator* it = new Table::Iterator(3);
  it->next();
}
`,
    }).filter((l) => l.startsWith("open"))).toEqual([
      "open Table.Iterator -> src/table.cpp:Table::Iterator.Iterator",
      "open it.next -> src/table.cpp:Table::Iterator.next",
    ]);
  });
});

const sides = (ns: string, word: string) => `namespace ${ns} {
class Table {
public:
  static Table* make();
  void rank();
  class Iterator {
  public:
    Iterator(int at);
    void next();
  };
};
}
`;
const sidesBody = (ns: string, word: string) => `namespace ${ns} {
Table* Table::make() {
  ${word}();
  return nullptr;
}
void Table::rank() {
  ${word}();
}
Table::Iterator::Iterator(int at) {
  ${word}(at);
}
void Table::Iterator::next() {
  ${word}(1);
}
}
`;

describe.each(Object.entries(readers))("C++ alias of a class two namespaces of one header both declare (%s)", (_reader, read) => {
  const project = {
    "src/league.h": `#pragma once\n${sides("Home", "seek")}${sides("Away", "climb")}`,
    "src/league.cpp": `#include "league.h"\n${sidesBody("Home", "seek")}${sidesBody("Away", "climb")}`,
  };

  it("follows `using Rank = Home::Table` and a typedef of it to Home's class, never Away's namesake", () => {
    const links = linksOf(read, {
      ...project,
      "src/standings.cpp": `#include "league.h"
using Rank = Home::Table;
typedef Home::Table Chart;
void walk() {
  Rank* t = Rank::make();
  t->rank();
  Rank::Iterator* it = new Rank::Iterator(2);
  it->next();
  Chart* c = Chart::make();
}
`,
    }).filter((l) => l.startsWith("walk"));
    expect(links).toEqual([
      "walk Chart.make -> src/league.cpp:Home::Table.make",
      "walk Rank.Iterator -> src/league.cpp:Home::Table::Iterator.Iterator",
      "walk Rank.make -> src/league.cpp:Home::Table.make",
      "walk it.next -> src/league.cpp:Home::Table::Iterator.next",
      "walk t.rank -> src/league.cpp:Home::Table.rank",
    ]);
  });

  it("joins `new Home::Table::Iterator(…)` to its own namespace's nested class", () => {
    const links = linksOf(read, {
      ...project,
      "src/standings.cpp": `#include "league.h"
void open() {
  Home::Table::Iterator* it = new Home::Table::Iterator(3);
  it->next();
}
`,
    }).filter((l) => l.startsWith("open"));
    expect(links).toEqual([
      "open Home::Table::Iterator -> src/league.cpp:Home::Table::Iterator.Iterator",
      "open it.next -> src/league.cpp:Home::Table::Iterator.next",
    ]);
  });
});
