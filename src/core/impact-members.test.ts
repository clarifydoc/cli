import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { impactOfContents } from "./impact-proposed.js";
import { filesNaming, targetsFromNames } from "./member-dependents.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const CLUB = [
  "export interface Club {",
  "  id: number;",
  "  name: string;",
  "}",
  "",
  "export class Squad {",
  "  signPlayer(name: string): string {",
  '    return "signed " + name;',
  "  }",
  "  sellPlayer(name: string): string {",
  '    return "sold " + name;',
  "  }",
  "}",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "src/club.ts": CLUB,
  "src/build-a.ts": 'import { Club } from "./club";\nexport const north: Club = { id: 1, name: "North Rovers" };\n',
  "src/build-b.ts": 'import { Club } from "./club";\nexport function makeClub(id: number): Club {\n  return { id, name: "South United" };\n}\n',
  "src/reads-name.ts": 'import { Club } from "./club";\nexport function label(c: Club) {\n  return c.name.toUpperCase();\n}\n',
  "src/relay-1.ts": 'import { Club } from "./club";\nimport { forward } from "./sink";\nexport function relay1(c: Club) {\n  return forward(c);\n}\n',
  "src/relay-2.ts": 'import { Club } from "./club";\nimport { forward } from "./sink";\nexport function relay2(c: Club) {\n  return forward(c);\n}\n',
  "src/sink.ts": "export function forward(x: unknown) {\n  return JSON.stringify(x);\n}\n",
  "src/report.ts": 'import { Squad } from "./club";\nexport function describe(s: Squad) {\n  return typeof s;\n}\n',
  "src/sales.ts": 'import { Squad } from "./club";\nconst squad = new Squad();\nexport function sell() {\n  return squad.sellPlayer("Ben");\n}\n',
  "src/transfers.ts": 'import { Squad } from "./club";\nconst squad = new Squad();\nexport function buy() {\n  return squad.signPlayer("Ali");\n}\n',
};

describe("impact charges the files that name what changed", () => {
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-members-"));
    root = join(dir, "app");
    await mkdir(join(root, "src"), { recursive: true });
    for (const [f, text] of Object.entries(FILES)) await writeFile(join(root, f), text);
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const run = (file: string, content: string) => impactOfContents(summary, join(dir, "out"), root, new Map([[file, content]]));

  it("an interface gaining a required member charges what builds the type, not what passes it on", async () => {
    const r = await run("src/club.ts", CLUB.replace("  name: string;\n", "  name: string;\n  stadium: string;\n"));
    expect(r.dependents).toEqual(["src/build-a.ts", "src/build-b.ts"]);
    expect(r.narrowed?.importers).toBe(8);
    expect(r.risk.level).not.toBe("high");
  });

  it("a type losing a member charges every file that uses the type", async () => {
    const r = await run("src/club.ts", CLUB.replace("  name: string;\n", ""));
    expect(r.dependents).toEqual(["src/build-a.ts", "src/build-b.ts", "src/reads-name.ts", "src/relay-1.ts", "src/relay-2.ts"]);
  });

  it("a member change charges the files that call it, not those naming its class or a sibling", async () => {
    const r = await run("src/club.ts", CLUB.replace("signPlayer(name: string)", "signPlayer(name: string, fee: number)"));
    expect(r.dependents).toEqual(["src/transfers.ts"]);
    expect(r.symbolImpact?.direct.map((c) => c.symbol)).toEqual(["buy"]);
    expect(r.narrowed?.why).toEqual([{ file: "src/transfers.ts", reasons: ["calls Squad.signPlayer"] }]);
  });

  it("a change outside any function or type keeps every importer charged", async () => {
    const r = await run("src/club.ts", `${CLUB}\nexport const founded = 1900;\n`);
    expect(r.narrowed).toBeUndefined();
    expect(r.dependentCount).toBe(8);
  });

  it("blast_radius members name the same files, an added interface member only its builders", () => {
    const sales = filesNaming(summary, targetsFromNames(summary, "src/club.ts", ["Squad.sellPlayer"]));
    expect([...sales.files.keys()]).toEqual(["src/sales.ts"]);
    const added = filesNaming(summary, targetsFromNames(summary, "src/club.ts", ["Club"], true));
    expect([...added.files.keys()].sort()).toEqual(["src/build-a.ts", "src/build-b.ts"]);
  });
});

describe("impact keeps what a member rule cannot judge", () => {
  const GARAGE = [
    "function checkBay(bay: number): boolean {",
    "  return bay > 0;",
    "}",
    "",
    "export function park(bay: number): string {",
    '  return checkBay(bay) ? "parked" : "full";',
    "}",
    "",
  ].join("\n");
  const BARREL = ['import { forward } from "./sink";', "", "export { forward };", "", "export function own(): number {", "  return 1;", "}", ""].join("\n");
  const SHOWROOM = ["export interface Car {", "  plate: string;", "}", ""].join("\n");
  const FILES2: Record<string, string> = {
    "src/garage.ts": GARAGE,
    "src/lot.ts": 'import { park } from "./garage";\nexport function arrive() {\n  return park(1);\n}\n',
    "src/sink.ts": "export function forward(x: unknown) {\n  return JSON.stringify(x);\n}\n",
    "src/sink2.ts": "export function forward(x: unknown) {\n  return String(x);\n}\n",
    "src/barrel.ts": BARREL,
    "src/lot.test.ts": 'import { arrive } from "./lot";\nexport function testArrive() {\n  return arrive();\n}\n',
    "src/fleet.ts": 'export class Truck {\n  plate: string = "";\n}\n',
    "src/builds-truck.ts": 'import { Truck } from "./fleet";\nexport function build() {\n  return new Truck();\n}\n',
    "src/names-truck.ts": 'import { Truck } from "./fleet";\nexport function show(t: Truck) {\n  return typeof t;\n}\n',
    "src/uses-own.ts": 'import { own } from "./barrel";\nexport function count() {\n  return own();\n}\n',
    "src/uses-barrel.ts": 'import { forward } from "./barrel";\nexport function send() {\n  return forward(1);\n}\n',
    "src/showroom.ts": SHOWROOM,
    "src/holds-car.ts": 'import { Car } from "./showroom";\nexport const demo: Car = { plate: "A-1" };\n',
    "src/returns-car.ts": 'import { Car } from "./showroom";\nexport function pick(): Car {\n  return { plate: "B-2" };\n}\n',
  };
  let dir: string;
  let root: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-members2-"));
    root = join(dir, "app");
    await mkdir(join(root, "src"), { recursive: true });
    for (const [f, text] of Object.entries(FILES2)) await writeFile(join(root, f), text);
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const run = (file: string, content: string) => impactOfContents(summary, join(dir, "out"), root, new Map([[file, content]]));

  it("a helper removed with only the edited function calling it breaks nothing", async () => {
    const r = await run("src/garage.ts", GARAGE.replace("checkBay(bay) ?", "bay > 0 ?").replace(/function checkBay[\s\S]*?\n}\n\n/, ""));
    expect(r.symbolImpact?.signatureChanges?.filter((c) => c.breaking)).toEqual([]);
    expect(r.risk.reasons.join("\n")).not.toContain("breaks the callers");
    expect(r.dependents).toEqual(["src/lot.ts"]);
  });

  it("a helper removed while another function that stays still calls it is breaking", async () => {
    const r = await run("src/garage.ts", GARAGE.replace(/function checkBay[\s\S]*?\n}\n\n/, ""));
    expect(r.symbolImpact?.signatureChanges?.filter((c) => c.breaking).map((c) => c.symbol)).toEqual(["checkBay"]);
  });

  it("an import edited in a file that re-exports it charges the importers naming it, not those of its other exports", async () => {
    const r = await run("src/barrel.ts", BARREL.replace('"./sink"', '"./sink2"'));
    expect(r.dependents).toEqual(["src/uses-barrel.ts"]);
  });

  it("a required member added to an interface charges a file that holds or returns a value of the type", async () => {
    const r = await run("src/showroom.ts", SHOWROOM.replace("  plate: string;\n", "  plate: string;\n  colour: string;\n"));
    expect(r.dependents).toEqual(["src/holds-car.ts", "src/returns-car.ts"]);
  });

  it("a helper removed is still breaking when the caller that stays is edited on another line", async () => {
    const r = await run("src/garage.ts", GARAGE.replace("park(bay: number)", "park(bay: number, lot = 1)").replace(/function checkBay[\s\S]*?\n}\n\n/, ""));
    expect(r.symbolImpact?.signatureChanges?.filter((c) => c.breaking).map((c) => c.symbol)).toEqual(["checkBay"]);
  });

  it("the tests that reach the files naming the change are still listed", async () => {
    const r = await run("src/garage.ts", GARAGE.replace("bay > 0 ?", "bay > 1 ?").replace("checkBay(bay) ?", "bay > 1 ?"));
    expect(r.dependents).toEqual(["src/lot.ts"]);
    expect(r.tests).toContain("src/lot.test.ts");
  });

  it("a class gaining a field charges what builds it, not what only takes it", async () => {
    const r = await run("src/fleet.ts", 'export class Truck {\n  plate: string = "";\n  colour: string = "";\n}\n');
    expect(r.dependents).toEqual(["src/builds-truck.ts"]);
  });
});
