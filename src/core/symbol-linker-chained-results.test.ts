/**
 * A local initialized by a chain of calls, a construction spelled `Type.init(…)`, a member a destructuring
 * pattern reads, and a structured binding of a pair: typed through the declarations, never by a method's name.
 * Each case has a same-named decoy on an unrelated class that must stay unlinked.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "chained-results-"));
  const out = await mkdtemp(join(tmpdir(), "chained-results-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** Each call `from` makes: `callName -> file::symbol`. */
function callsFrom(analyses: FileAnalysis[], from: string): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.sourceFile === from && l.sourceSymbol !== "(reference)")
    .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

describe("chained call results", () => {
  it("Go: a local initialized by a call chain is typed by the last method's declared return", async () => {
    const analyses = await analyzeAll(
      {
        "league/club.go": [
          "package league",
          "type City struct{}",
          "func (c *City) Save() {}",
          "type Address struct{}",
          "func (a *Address) City() *City { return &City{} }",
          "type Club struct{}",
          "func (c *Club) Address() *Address { return &Address{} }",
          "",
        ].join("\n"),
        "league/depot.go": ["package league", "type Depot struct{}", "func (d *Depot) Save() {}", ""].join("\n"),
        "league/run.go": ["package league", "func Run(club *Club) {", "\tcity := club.Address().City()", "\tcity.Save()", "}", ""].join("\n"),
      },
      "go",
    );
    const calls = callsFrom(analyses, "league/run.go");
    expect(calls).toContain("city.Save -> league/club.go::City.Save");
    expect(calls.join("\n")).not.toContain("depot.go");
  });

  it("Swift: a chain of calls types the local, and Type.init(…) is a construction of Type", async () => {
    const analyses = await analyzeAll(
      {
        "Garage.swift": [
          "class Engine { func rev() {} }",
          "class Car {",
          "    func engine() -> Engine { return Engine() }",
          "    init() {}",
          "    func honk() {}",
          "}",
          "class Garage { func car() -> Car { return Car() } }",
          "func run(garage: Garage) {",
          "    let e = garage.car().engine()",
          "    e.rev()",
          "    let c = Car.init()",
          "    c.honk()",
          "}",
          "",
        ].join("\n"),
        "Radio.swift": ["class Radio { func rev() {} func honk() {} }", ""].join("\n"),
      },
      "swift",
    );
    const calls = callsFrom(analyses, "Garage.swift");
    expect(calls).toContain("e.rev -> Garage.swift::Engine.rev");
    expect(calls).toContain("c.honk -> Garage.swift::Car.honk");
    expect(calls.join("\n")).not.toContain("Radio");
  });

  it("TypeScript: a member destructured from a method's result or from a value is typed by its declaration", async () => {
    const analyses = await analyzeAll(
      {
        "club.ts": [
          "export class Coach { train(): void {} }",
          "export class Staff { coach: Coach = new Coach(); }",
          "export class Club {",
          "  staff(): Staff { return new Staff(); }",
          "  manager: Coach = new Coach();",
          "}",
          "",
        ].join("\n"),
        "fan.ts": ["export class Fan { train(): void {} }", ""].join("\n"),
        "run.ts": [
          'import { Club } from "./club";',
          "export function run(club: Club) {",
          "  const { coach } = club.staff();",
          "  coach.train();",
          "  const { manager } = club;",
          "  manager.train();",
          "}",
          "",
        ].join("\n"),
      },
      "typescript",
    );
    const calls = callsFrom(analyses, "run.ts");
    expect(calls.filter((c) => c === "coach.train -> club.ts::Coach.train")).toHaveLength(1);
    expect(calls.filter((c) => c === "manager.train -> club.ts::Coach.train")).toHaveLength(1);
    expect(calls.join("\n")).not.toContain("fan.ts");
  });

  it("TypeScript: a destructured member of an untyped value links nothing", async () => {
    const analyses = await analyzeAll(
      {
        "club.ts": ["export class Coach { train(): void {} }", ""].join("\n"),
        "fan.ts": ["export class Fan { train(): void {} }", ""].join("\n"),
        "run.ts": ["export function run(club: any) {", "  const { coach } = club.staff();", "  coach.train();", "}", ""].join("\n"),
      },
      "typescript",
    );
    expect(callsFrom(analyses, "run.ts").filter((c) => c.startsWith("coach.train"))).toEqual([]);
  });

  it("C++: a structured binding of a declared std::pair return is typed by position", async () => {
    const analyses = await analyzeAll(
      {
        "league.cpp": [
          "#include <utility>",
          "class Club { public: void promote() {} };",
          "class Player { public: void sign() {} };",
          "std::pair<Club, Player> pairOf() { return {}; }",
          "void run() {",
          "  auto [club, player] = pairOf();",
          "  club.promote();",
          "  player.sign();",
          "}",
          "",
        ].join("\n"),
        "referee.cpp": ["class Referee { public: void promote() {} void sign() {} };", ""].join("\n"),
      },
      "cpp",
    );
    const calls = callsFrom(analyses, "league.cpp");
    expect(calls).toContain("club.promote -> league.cpp::Club.promote");
    expect(calls).toContain("player.sign -> league.cpp::Player.sign");
    expect(calls.join("\n")).not.toContain("referee.cpp");
  });
});
