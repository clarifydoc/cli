import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A type written through a namespace whose name is CamelCase (`LeagueCore::Valve`) reads as a nested class path. When
 * no class bears that name but `Valve` is declared in namespace `LeagueCore`, it is that class — never the file's
 * own anonymous-namespace `Valve`, and a qualifier no declaration bears out (`OtherCore::Valve`) names nothing.
 */
const FILES: Record<string, string> = {
  "core.h": `namespace LeagueCore {\nclass Valve {\npublic:\n  void open();\n  void close();\n};\n}\n`,
  "core.cpp": `#include "core.h"\nnamespace LeagueCore {\nvoid Valve::open() {}\nvoid Valve::close() {}\n}\n`,
  "holder.cpp": [
    `#include "core.h"`,
    `namespace {`,
    `class Valve {`,
    `public:`,
    `  void open();`,
    `};`,
    `void Valve::open() {}`,
    `}`,
    ``,
    `class Holder {`,
    `public:`,
    `  LeagueCore::Valve v;`,
    `  OtherCore::Valve d;`,
    `  void run() { v.open(); }`,
    `  void spare() { d.open(); }`,
    `};`,
    ``,
    `void use_param(LeagueCore::Valve& p) { p.open(); }`,
    `void decoy_param(OtherCore::Valve& q) { q.open(); }`,
    `void use_local() {`,
    `  LeagueCore::Valve w;`,
    `  w.open();`,
    `}`,
    `void decoy_local() {`,
    `  OtherCore::Valve z;`,
    `  z.open();`,
    `}`,
    ``,
  ].join("\n"),
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("C++ type written through a CamelCase namespace (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-cpp-camelcase-"));
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
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.relation === "calls").map((l) => `${l.callName} -> ${l.targetFile}`);

  it("links a field, a parameter and a local to the class of the namespace, past the anonymous namesake", () => {
    expect(linkOf("Holder.run")).toEqual(["v.open -> core.cpp"]);
    expect(linkOf("use_param")).toEqual(["p.open -> core.cpp"]);
    expect(linkOf("use_local")).toEqual(["w.open -> core.cpp"]);
  });

  it("links nothing through a qualifier no declaration bears out", () => {
    expect(linkOf("Holder.spare")).toEqual([]);
    expect(linkOf("decoy_param")).toEqual([]);
    expect(linkOf("decoy_local")).toEqual([]);
  });
});
