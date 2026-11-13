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

const shape = (a: FileAnalysis) => ({
  classes: a.classes.map((c) => ({
    name: c.name,
    namespace: c.namespace,
    methods: c.methods.map((m) => m.name),
    props: c.properties.map((p) => `${p.name}:${p.type}`),
  })),
  functions: a.functions.map((f) => f.name),
});

describe.each(Object.entries(readers))("C++ class bodies on one line (%s)", (_reader, read) => {
  it("gives a struct its method and field when a field comes first", () => {
    const a = read(`struct First { int id; };
struct Base { First actions; void Work() {} };
void run() { Base b; b.Work(); }
`, "src/base.cpp");
    expect(shape(a)).toEqual({
      classes: [
        { name: "First", namespace: undefined, methods: [], props: ["id:int"] },
        { name: "Base", namespace: undefined, methods: ["Work"], props: ["actions:First"] },
      ],
      functions: ["run"],
    });
  });

  it("reads the one-line shape as it reads the same code over several lines", () => {
    const one = read(`struct Base { First actions; void Work() {} int total() const { return 1; } };\n`, "a.cpp");
    const many = read(`struct Base {
  First actions;
  void Work() {}
  int total() const { return 1; }
};
`, "b.cpp");
    expect(shape(one)).toEqual(shape(many));
  });

  it.skipIf(_reader === "regex")("keeps a free function written after a one-line class on its line", () => {
    const a = read(`struct Base { void Work() {} }; void helper() {}\n`, "a.cpp");
    expect(a.classes[0]!.methods.map((m) => m.name)).toEqual(["Work"]);
    expect(a.functions.map((f) => f.name)).toContain("helper");
    expect(a.functions.map((f) => f.name)).not.toContain("Work");
  });

  it("finds a class inside a namespace written on its line, qualified by that namespace", () => {
    const a = read(`namespace league { struct Club { void Play() {} int rank; }; }
namespace league { namespace util { struct Kit { void Wear() {} }; } }
namespace { struct Hidden { void Tuck() {} }; }
`, "src/club.cpp");
    expect(shape(a).classes).toEqual([
      { name: "Club", namespace: "league", methods: ["Play"], props: ["rank:int"] },
      { name: "Kit", namespace: "league::util", methods: ["Wear"], props: [] },
      { name: "Hidden", namespace: undefined, methods: ["Tuck"], props: [] },
    ]);
    expect(a.functions.map((f) => f.name)).toEqual([]);
  });

  it("links calls through both one-line shapes", () => {
    const files = {
      "src/base.h": `struct First { int id; };
struct Base { First actions; void Work() {} };
namespace league { struct Club { void Play() {} }; }
`,
      "src/run.cpp": `#include "base.h"
void run() {
  Base b;
  b.Work();
  league::Club c;
  c.Play();
}
`,
    };
    const links = buildSymbolLinks(Object.entries(files).map(([rel, src]) => read(src, rel)))
      .map((l) => `${l.callName} -> ${l.targetFile}:${l.targetSymbol}`)
      .sort();
    expect(links).toEqual(["b.Work -> src/base.h:Base.Work", "c.Play -> src/base.h:Club.Play"]);
  });
});
