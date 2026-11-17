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

describe.each(Object.entries(readers))("C++ foreign-namespace namesake (%s)", (_reader, read) => {
  const home = {
    "src/home.h": `#pragma once
namespace home {
class Twin {
public:
  void go();
};
}
`,
    "src/home.cpp": `#include "home.h"
namespace home {
void Twin::go() { kick(); }
}
`,
  };

  it("does not link lib::Twin to the project's home::Twin when no alias names lib", () => {
    const links = linksOf(read, {
      ...home,
      "src/use.cpp": `#include "home.h"
void play() {
  lib::Twin u;
  u.go();
}
`,
    });
    expect(links.some((l) => l.includes("u.go") && l.includes("Twin.go"))).toBe(false);
  });

  it("links lib::Twin through a namespace alias to home::Twin, never a decoy", () => {
    expect(linksOf(read, {
      ...home,
      "src/decoy.h": `#pragma once
namespace decoy {
class Twin {
public:
  void go();
};
}
`,
      "src/decoy.cpp": `#include "decoy.h"
namespace decoy {
void Twin::go() { miss(); }
}
`,
      "src/use.cpp": `#include "home.h"
namespace lib = home;
void play() {
  lib::Twin u;
  u.go();
}
`,
    })).toEqual([
      "src/use.cpp:play u.go -> src/home.cpp:Twin.go",
    ]);
  });
});

describe.each(Object.entries(readers))("C++ two same-named classes on one line (%s)", (_reader, read) => {
  it("keeps each one-line Twin's own method, and does not link through a decoy namesake", () => {
    const files = {
      "src/twins.cpp": `struct Twin { void home() { sing(); } }; struct Twin { void away() { boo(); } };
void play() {
  Twin a;
  a.home();
  a.away();
}
`,
      "src/decoy.h": `#pragma once
namespace decoy {
struct Twin {
  void home();
  void away();
};
}
`,
      "src/decoy.cpp": `#include "decoy.h"
namespace decoy {
void Twin::home() { clap(); }
void Twin::away() { hiss(); }
}
`,
    };
    const twins = read(files["src/twins.cpp"]!, "src/twins.cpp");
    const methods = twins.classes.map((c) => ({ name: c.name, methods: c.methods.map((m) => m.name).sort() }));
    expect(methods).toEqual([
      { name: "Twin", methods: ["home"] },
      { name: "Twin", methods: ["away"] },
    ]);
    const links = linksOf(read, files);
    expect(links.some((l) => l.includes("decoy.cpp"))).toBe(false);
    expect(links.filter((l) => l.includes("a.home") || l.includes("a.away")).sort()).toEqual([
      "src/twins.cpp:play a.away -> src/twins.cpp:Twin.away",
      "src/twins.cpp:play a.home -> src/twins.cpp:Twin.home",
    ]);
  });
});
