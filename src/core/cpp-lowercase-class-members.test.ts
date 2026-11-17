import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A member defined outside a LOWERCASE class (`void garage::park() {…}` in `garage.cpp`) is read as a function of a
 * namespace `garage`; a call on a typed `garage` reaches it when the file defining it includes the class's header.
 * A namesake class in another folder (`low2/garage.h`) keeps its own definitions.
 */
const FILES: Record<string, string> = {
  "low/garage.h": `class garage {\npublic:\n  void park(int x);\n  static int make();\n};\n`,
  "low/garage.cpp": `#include "garage.h"\nvoid garage::park(int x) {}\nint garage::make() { return 1; }\n`,
  "low2/garage.h": `class garage {\npublic:\n  void park(int x);\n  void wash();\n};\n`,
  "low2/garage.cpp": `#include "garage.h"\nvoid garage::park(int x) {}\nvoid garage::wash() {}\n`,
  "first_user.cpp": `#include "low/garage.h"\nvoid first_user() {\n  garage g;\n  g.park(1);\n  g.wash();\n}\n`,
  "second_user.cpp": `#include "low2/garage.h"\nvoid second_user() {\n  garage g;\n  g.park(1);\n  g.wash();\n  g.missing();\n}\n`,
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("C++ members of a lowercase class defined out of line (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cpp-lowercase-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    const previous = process.env.CLARIFYDOC_FEATURES;
    if (feature) process.env.CLARIFYDOC_FEATURES = feature;
    try {
      await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    } finally {
      if (previous === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = previous;
    }
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.relation === "calls").map((l) => `${l.callName} -> ${l.targetFile}`).sort();

  it("links a call on a typed lowercase class to the definition its own header's .cpp holds", () => {
    expect(linkOf("first_user")).toEqual(["g.park -> low/garage.cpp"]);
  });

  it("keeps a namesake class's definitions apart and links no member the class lacks", () => {
    expect(linkOf("second_user")).toEqual(["g.park -> low2/garage.cpp", "g.wash -> low2/garage.cpp"]);
  });
});
