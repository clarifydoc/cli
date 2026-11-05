import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-swift-nested-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetFile}:${l.targetSymbol}:${l.strategy}`);

describe("Swift nested types are named by their path", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Sources/League.swift": `struct League {
    class Table {
        func rank() {}
    }
    func build() { let t = Table(); t.rank() }
}
`,
      "Sources/Cup.swift": `struct Cup {
    class Table {
        func rank() {}
        func seed() {}
    }
}
`,
      "Sources/Use.swift": `class Coach {
    func run() {
        let t = League.Table()
        t.rank()
        let u: Cup.Table = Cup.Table()
        u.seed()
        var w: League.Table? = nil
        w?.rank()
    }
}
`,
    }));
  });
  afterAll(async () => done());

  it("keeps two nested types of one leaf name apart", () => {
    expect(targets(summary, "Coach.run", "t.rank")).toEqual(["Sources/League.swift:League::Table.rank:injection"]);
    expect(targets(summary, "Coach.run", "u.seed")).toEqual(["Sources/Cup.swift:Cup::Table.seed:injection"]);
    expect(targets(summary, "Coach.run", "w.rank")).toEqual(["Sources/League.swift:League::Table.rank:injection"]);
  });
  it("resolves a construction through the path, and a bare name inside the nesting type", () => {
    expect(targets(summary, "Coach.run", "League.Table")).toEqual(["Sources/League.swift:League::Table:constructor"]);
    expect(targets(summary, "Coach.run", "Cup.Table")).toEqual(["Sources/Cup.swift:Cup::Table:constructor"]);
    expect(targets(summary, "League.build", "t.rank")).toEqual(["Sources/League.swift:League::Table.rank:injection"]);
  });
});

describe("Swift loops over class members and call results", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Sources/Squad.swift": `class Squad {
    var players: [Player] = []
    func list() -> [Player] { return players }
}
class Player { func train() {} }
class Decoy { func train() {} }
`,
      "Sources/Coach.swift": `class Coach {
    var squad = Squad()
    var roster: [Player] = []
    func memberLoop() { for p in self.roster { p.train() } }
    func bareLoop() { for p in roster { p.train() } }
    func callLoop() { for q in squad.list() { q.train() } }
    func shadowed(roster: [Decoy]) { for d in roster { d.train() } }
}
class Garage { var car: Car = Car(); var n = 1; func open() { car.start() }; func close() { car.start() } }
class Car { func start() {} }
class Gate { func start() {} }
`,
    }));
  });
  afterAll(async () => done());

  it("types a loop variable over a property or a call's declared collection", () => {
    expect(targets(summary, "Coach.memberLoop", "p.train")).toEqual(["Sources/Squad.swift:Player.train:injection"]);
    expect(targets(summary, "Coach.bareLoop", "p.train")).toEqual(["Sources/Squad.swift:Player.train:injection"]);
    expect(targets(summary, "Coach.callLoop", "q.train")).toEqual(["Sources/Squad.swift:Player.train:injection"]);
  });
  it("lets a parameter of the property's name shadow it", () => {
    expect(targets(summary, "Coach.shadowed", "d.train")).toEqual(["Sources/Squad.swift:Decoy.train:injection"]);
  });
  it("keeps the properties of a class written on one line", () => {
    expect(targets(summary, "Garage.open", "car.start")).toEqual(["Sources/Coach.swift:Car.start:injection"]);
    expect(targets(summary, "Garage.close", "car.start")).toEqual(["Sources/Coach.swift:Car.start:injection"]);
  });
});

describe("Swift accessors on the regex front end", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    const before = process.env.CLARIFYDOC_FEATURES;
    process.env.CLARIFYDOC_FEATURES = "no-tree-sitter:swift";
    try {
      ({ summary, done } = await scan({
        "Sources/Garage.swift": `class Car { func start() {} }
class Gate { func start() {} }
class Garage {
    var car: Car = Car()
    var ready: Bool {
        car.start()
        return true
    }
    var level: Int = 0 {
        didSet { car.start() }
    }
    var open: Bool { get }
}
`,
      }));
    } finally {
      if (before === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = before;
    }
  });
  afterAll(async () => done());

  it("makes a computed or observed property a function of its own, but not a protocol requirement", () => {
    expect(targets(summary, "Garage.ready", "car.start")).toEqual(["Sources/Garage.swift:Car.start:injection"]);
    expect(targets(summary, "Garage.level", "car.start")).toEqual(["Sources/Garage.swift:Car.start:injection"]);
    const garage = summary.symbolLinks.filter((l) => l.sourceSymbol === "Garage.open");
    expect(garage).toEqual([]);
  });
});

describe("Objective-C construction", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "Player.h": "@interface Player : NSObject\n- (void)train;\n@end\n@interface Coach : NSObject\n- (void)run;\n@end\n",
      "Player.m": `#import "Player.h"
@implementation Player
- (void)train {}
@end
@implementation Coach
- (void)run {
    Player *p = [[Player alloc] init];
    [p train];
    Player *q = [Player new];
    NSObject *o = [[NSObject alloc] init];
}
@end
`,
    }));
  });
  afterAll(async () => done());

  it("links init and new on a class declaring no init to the class, and leaves no alloc row", () => {
    expect(targets(summary, "Coach.run", "Player.init")).toEqual(["Player.m:Player:constructor"]);
    expect(targets(summary, "Coach.run", "Player.new")).toEqual(["Player.m:Player:constructor"]);
    expect(targets(summary, "Coach.run", "p.train")).toEqual(["Player.m:Player.train:injection"]);
    const calls = summary.symbolLinks.filter((l) => l.sourceSymbol === "Coach.run" && l.callName.endsWith(".alloc"));
    expect(calls).toEqual([]);
  });
});
