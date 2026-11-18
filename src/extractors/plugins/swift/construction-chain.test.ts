import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractCallsFromBody } from "../shared/regex-base.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { swiftSpec } from "./index.js";

const calls = (line: string) => extractCallsFromBody([line], 0, 1, ["//"], swiftSpec.callPatterns);

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-swift-ctor-chain-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetFile}:${l.targetSymbol}:${l.strategy}`);

describe("Swift construction-chain calls on the regex front end", () => {
  it("names try await Club().sign() as Club.sign on Club", () => {
    expect(calls("try await Club().sign()").find((c) => c.name === "Club.sign")).toMatchObject({
      name: "Club.sign",
      receiverType: "Club",
    });
    expect(calls("let report = Club(id: 7).squad()").find((c) => c.name === "Club.squad")).toMatchObject({
      receiverType: "Club",
    });
    // A typed local stays a bare member call; the construction pattern does not touch it.
    expect(calls("try await club.sign()").every((c) => c.name === "club.sign" && !c.receiverType)).toBe(true);
  });

  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    const before = process.env.CLARIFYDOC_FEATURES;
    process.env.CLARIFYDOC_FEATURES = "no-tree-sitter:swift";
    try {
      ({ summary, done } = await scan({
        "Sources/Club.swift": `final class Club {
    func sign() async throws {}
}
final class Bike {
    func sign() async throws {}
}
`,
        "Sources/Roster.swift": `func recruit() async throws {
    try await Club().sign()
}
func hire() async throws {
    let club = Club()
    try await club.sign()
}
`,
      }));
    } finally {
      if (before === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = before;
    }
  });
  afterAll(async () => done());

  it("links try await Club().sign() to Club.sign, not Bike.sign", () => {
    expect(targets(summary, "recruit", "Club.sign")).toEqual(["Sources/Club.swift:Club.sign:injection"]);
    expect(targets(summary, "hire", "club.sign")).toEqual(["Sources/Club.swift:Club.sign:injection"]);
    expect(summary.symbolLinks.filter((l) => l.targetSymbol === "Bike.sign")).toEqual([]);
  });
});
