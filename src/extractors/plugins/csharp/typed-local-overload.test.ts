/**
 * E-365: a call whose argument is a local of a built-in type (`csharp`) chooses the overload that type selects, through the
 * real per-file pipeline and the linker. The overload of the matching type is declared first and last in turn, so a
 * link that merely keeps the last-declared definition cannot pass both; a local no declaration or literal types
 * (the result of a call) states no kind.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyze(rel: string, src: string): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "typed-local-"));
  const out = await mkdtemp(join(tmpdir(), "typed-local-out-"));
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "csharp" },
    frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: root, tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

/** `Caller -> line of the overload it reaches`, for the calls of the overloaded method. */
async function chosen(rel: string, src: string, callee: RegExp): Promise<string[]> {
  const a = await analyze(rel, src);
  return buildSymbolLinks([a]).filter((l) => callee.test(l.callName)).map((l) => `${l.sourceSymbol} -> ${l.targetLine}`);
}

const squad = (first: "string" | "int") => `namespace League {
class Squad {
  public int Pick(${first} a) { return 1; }
  public int Pick(${first === "string" ? "int" : "string"} b) { return 2; }
}
class Coach {
  object Load() { return null; }
  void Typed(Squad squad) { string who = "Ada"; squad.Pick(who); }
  void Number(Squad squad) { int shirt = 7; squad.Pick(shirt); }
  void Inferred(Squad squad) { var keeper = "Bo"; squad.Pick(keeper); }
  void Counted(Squad squad) { var n = 5; squad.Pick(n); }
  void Param(Squad squad, string keeper) { squad.Pick(keeper); }
  void Shadow(Squad squad, int who) {
    { string inner = "z"; squad.Pick(inner); }
    squad.Pick(who);
  }
}}
`;

describe("C# typed local argument (E-365)", () => {
  it.each([["string", { str: 3, num: 4 }], ["int", { str: 4, num: 3 }]] as const)("chooses by the local's type, %s overload declared first", async (first, at) => {
    const links = await chosen("Squad.cs", squad(first), /Pick/);
    expect(links.sort()).toEqual([
      `Coach.Counted -> ${at.num}`, `Coach.Inferred -> ${at.str}`, `Coach.Number -> ${at.num}`, `Coach.Param -> ${at.str}`,
      `Coach.Shadow -> ${at.num}`, `Coach.Shadow -> ${at.str}`, `Coach.Typed -> ${at.str}`,
    ].sort());
  });

  it("states no kind for a local typed by a call's result", async () => {
    const a = await analyze("Squad.cs", `class Coach { object Load() { return null; } void Run(Squad squad) { var x = Load(); squad.Pick(x); } }`);
    const call = a.classes[0]!.methods.find((m) => m.name === "Run")!.calls.find((c) => c.name === "squad.Pick")!;
    expect(call.argKinds ?? ["?"]).toEqual(["?"]);
  });
});
