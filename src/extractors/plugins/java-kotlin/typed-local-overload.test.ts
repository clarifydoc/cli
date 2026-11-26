/**
 * E-365: a call whose argument is a local of a built-in type (`java`) chooses the overload that type selects, through the
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
    file: { absolutePath: join(root, rel), relativePath: rel, language: (rel.endsWith(".kt") ? "kotlin" : "java") as never },
    frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false }, verbose: false, projectRoot: root, tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

/** `Caller -> line of the overload it reaches`, for the calls of the overloaded method. */
async function chosen(rel: string, src: string, callee: RegExp): Promise<string[]> {
  const a = await analyze(rel, src);
  return buildSymbolLinks([a]).filter((l) => callee.test(l.callName)).map((l) => `${l.sourceSymbol} -> ${l.targetLine}`);
}

const java = (first: "String" | "int") => `package league;
class Squad {
  int pick(${first} a) { return 1; }
  int pick(${first === "String" ? "int" : "String"} b) { return 2; }
}
class Coach {
  Object load() { return null; }
  void typed(Squad squad) { String who = "Ada"; squad.pick(who); }
  void number(Squad squad) { int shirt = 7; squad.pick(shirt); }
  void inferred(Squad squad) { var keeper = "Bo"; squad.pick(keeper); }
  void counted(Squad squad) { var n = 5; squad.pick(n); }
  void param(Squad squad, String keeper) { squad.pick(keeper); }
  void shadow(Squad squad, int who) {
    { String inner = "z"; squad.pick(inner); }
    squad.pick(who);
  }
}
`;

const kotlin = (first: "String" | "Int") => `package league
class Squad {
  fun pick(a: ${first}): Int = 1
  fun pick(b: ${first === "String" ? "Int" : "String"}): Int = 2
}
class Coach {
  fun load(): Any? = null
  fun typed(squad: Squad) { val who = "Ada"; squad.pick(who) }
  fun number(squad: Squad) { val shirt: Int = 7; squad.pick(shirt) }
  fun annotated(squad: Squad) { val keeper: String = "Bo"; squad.pick(keeper) }
  fun counted(squad: Squad) { var n = 5; squad.pick(n) }
  fun param(squad: Squad, keeper: String) { squad.pick(keeper) }
  fun shadow(squad: Squad, who: Int) {
    run { val inner = "z"; squad.pick(inner) }
    squad.pick(who)
  }
}
`;

describe("Java typed local argument (E-365)", () => {
  it.each([["String", { str: 3, num: 4 }], ["int", { str: 4, num: 3 }]] as const)("chooses by the local's type, %s overload declared first", async (first, at) => {
    const links = await chosen("Squad.java", java(first), /pick/);
    expect(links.sort()).toEqual([
      `Coach.counted -> ${at.num}`, `Coach.inferred -> ${at.str}`, `Coach.number -> ${at.num}`, `Coach.param -> ${at.str}`,
      `Coach.shadow -> ${at.num}`, `Coach.shadow -> ${at.str}`, `Coach.typed -> ${at.str}`,
    ].sort());
  });

  it("states no kind for a local typed by a call's result", async () => {
    const a = await analyze("Squad.java", `class Coach { Object load() { return null; } void run(Squad squad) { var x = load(); squad.pick(x); } }`);
    const call = a.classes[0]!.methods.find((m) => m.name === "run")!.calls.find((c) => c.name === "squad.pick")!;
    expect(call.argKinds ?? ["?"]).toEqual(["?"]);
  });
});

describe("Kotlin typed local argument (E-365)", () => {
  it.each([["String", { str: 3, num: 4 }], ["Int", { str: 4, num: 3 }]] as const)("chooses by the local's type, %s overload declared first", async (first, at) => {
    const links = await chosen("Squad.kt", kotlin(first), /pick/);
    expect(links.sort()).toEqual([
      `Coach.annotated -> ${at.str}`, `Coach.counted -> ${at.num}`, `Coach.number -> ${at.num}`, `Coach.param -> ${at.str}`,
      `Coach.shadow -> ${at.num}`, `Coach.shadow -> ${at.str}`, `Coach.typed -> ${at.str}`,
    ].sort());
  });
});
