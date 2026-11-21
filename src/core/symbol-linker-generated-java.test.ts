/**
 * Java: calls into code a generator writes (enum `values()`/`valueOf`, AutoValue, Immutables) continue through the
 * synthesized members, and a namesake class of another package never answers them.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "java-gen-"));
  const out = await mkdtemp(join(tmpdir(), "java-gen-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "java" },
      frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false },
      verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

const rows = (a: FileAnalysis[], file: string) =>
  buildSymbolLinks(a).filter((l) => l.sourceFile === file)
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol} ${l.confidence} ${l.strategy}`);

describe("generated Java types", () => {
  it("links enum valueOf, AutoValue constructors and Immutables builders, and not a namesake elsewhere", async () => {
    const a = await analyzeAll({
      "league/Position.java": "package league;\npublic enum Position { KEEPER; String label() { return \"k\"; } }\n",
      "other/Position.java": "package other;\npublic class Position { public static Position valueOf(String s) { return null; } public String label() { return \"d\"; } }\n",
      "league/Club.java": "package league;\n@AutoValue\npublic abstract class Club { abstract String name(); String promote() { return name(); } }\n",
      "league/Match.java": "package league;\n@Value.Immutable\npublic interface Match { String home(); default String report() { return home(); } }\n",
      "other/ImmutableMatch.java": "package other;\npublic class ImmutableMatch { public static Builder builder() { return null; } public static class Builder { public Builder home(String h) { return this; } public ImmutableMatch build() { return null; } } public String report() { return \"d\"; } }\n",
      "league/Service.java": [
        "package league;",
        "public class Service {",
        "  void a(String s) { Position.valueOf(s).label(); }",
        "  void b() { new AutoValue_Club(\"x\").promote(); }",
        "  void c() { ImmutableMatch.builder().home(\"x\").build().report(); }",
        "}", "",
      ].join("\n"),
    });
    const r = rows(a, "league/Service.java");
    expect(r).toContain("Position.valueOf -> league/Position.java::Position.valueOf INFERRED class-name");
    expect(r).toContain("Position.valueOf(s).label -> league/Position.java::Position.label INFERRED injection");
    expect(r).toContain("new AutoValue_Club(\"x\").promote -> league/Club.java::Club.promote INFERRED injection");
    expect(r).toContain("ImmutableMatch.builder().home(\"x\").build().report -> league/Match.java::Match.report INFERRED injection");
    expect(r.some((x) => x.includes("other/"))).toBe(false);
  });
});
