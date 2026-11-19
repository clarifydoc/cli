import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";
import { tupleElementsText } from "../extractors/plugins/javascript/tuple-elements.js";

async function summaryOf(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-tuple-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol);

describe("TypeScript tuple destructuring", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({
    "league.ts": `export class Club { save(): void {} }
export class Player { save(): void {} }
export function load(): [Club, Player] { return [new Club(), new Player()]; }
export async function loadLater(): Promise<[Club, Player]> { return [new Club(), new Player()]; }
export function loadMany(): Club[] { return []; }
export function sync() {
  const [club, player] = load();
  club.save();
  player.save();
}
export async function later() {
  const [club, player] = await loadLater();
  club.save();
  player.save();
}
export function skipped() {
  const [, player] = load();
  player.save();
}
export function many() {
  const [first] = loadMany();
  first.save();
}
`,
  }), 120000));
  afterAll(async () => cleanup());

  it("types each name by its position", () => {
    expect(targets(summary, "sync", "club.save")).toEqual(["Club.save"]);
    expect(targets(summary, "sync", "player.save")).toEqual(["Player.save"]);
  });
  it("reads an awaited Promise of a tuple", () => {
    expect(targets(summary, "later", "club.save")).toEqual(["Club.save"]);
    expect(targets(summary, "later", "player.save")).toEqual(["Player.save"]);
  });
  it("counts a hole", () => {
    expect(targets(summary, "skipped", "player.save")).toEqual(["Player.save"]);
  });
  it("never reads an array as a tuple", () => {
    expect(targets(summary, "many", "first.save")).toEqual([]);
  });
});

describe("tupleElementsText", () => {
  it("reads tuples only", () => {
    expect(tupleElementsText("[Club, Player]")).toEqual(["Club", "Player"]);
    expect(tupleElementsText("readonly [Club, Map<string, Player>]")).toEqual(["Club", "Map<string, Player>"]);
    expect(tupleElementsText("[club: Club, player: Player]")).toEqual(["Club", "Player"]);
    expect(tupleElementsText("[Club, Player][]")).toBeNull();
    expect(tupleElementsText("[Club, ...Player[]]")).toBeNull();
    expect(tupleElementsText("[Club, Player?]")).toBeNull();
    expect(tupleElementsText("Club[]")).toBeNull();
  });
});

describe("Go multi-value returns", () => {
  let summary: ProjectAnalysis;
  let cleanup = async () => {};
  beforeAll(async () => ({ summary, cleanup } = await summaryOf({
    "league.go": `package league
type Club struct{}
func (c *Club) Save() {}
type Player struct{}
func (p *Player) Save() {}
type Repo struct{}
func (r *Repo) Find(id int) (*Club, error) { return &Club{}, nil }
func Promote(repo *Repo) {
	c, err := repo.Find(1)
	_ = err
	c.Save()
}
`,
  }), 120000));
  afterAll(async () => cleanup());
  it("types the first result by the declared results (already linked)", () => {
    expect(targets(summary, "Promote", "c.Save")).toEqual(["Club.Save"]);
  });
});
