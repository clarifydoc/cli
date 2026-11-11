import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";
import { cppCollectionElement } from "../extractors/plugins/cpp/collection-element.js";
import { phpCollectionElement } from "../extractors/plugins/php/collection-element.js";
import { rustCollectionElement } from "../extractors/plugins/rust/collection-element.js";

/** A loop variable over a call chain, a typed collection or a map: each language has a namesake `Car` that no link may reach. */
async function summaryOf(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-loop-vars-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol);

function suite(name: string, files: Record<string, string>, check: (t: (from: string, call: string) => string[]) => void): void {
  describe(name, () => {
    let summary: ProjectAnalysis;
    let cleanup = async () => {};
    beforeAll(async () => ({ summary, cleanup } = await summaryOf(files)), 120000);
    afterAll(async () => cleanup());
    it("types the loop variable", () => check((from, call) => targets(summary, from, call)));
  });
}

suite("Go chain", {
  "league.go": `package league
type Player struct{}
func (p *Player) Train() {}
type Car struct{}
func (c *Car) Train() {}
type Club struct{}
func (c *Club) Players() []*Player { return nil }
type League struct{}
func (l *League) Club(id int) *Club { return nil }
func (l *League) Cars() []*Car { return nil }
func Run(league *League) {
	for _, p := range league.Club(1).Players() {
		p.Train()
	}
	for _, c := range league.Cars() {
		c.Train()
	}
}
`,
}, (t) => {
  expect(t("Run", "p.Train")).toEqual(["Player.Train"]);
  expect(t("Run", "c.Train")).toEqual(["Car.Train"]);
});

suite("PHP foreach", {
  "League.php": `<?php
class Player { public function train() {} }
class Car { public function train() {} }
class Club {
  /** @return Player[] */
  public function players(): array { return []; }
}
class Garage {
  /** @return Car[] */
  public function cars(): array { return []; }
}
class Run {
  /** @param Player[] $players */
  public function a(Club $club, array $players) {
    foreach ($club->players() as $p) { $p->train(); }
    foreach ($players as $k => $q) { $q->train(); }
  }
  public function b(Garage $garage) {
    foreach ($garage->cars() as $c) { $c->train(); }
  }
}
`,
}, (t) => {
  expect(t("Run.a", "p.train")).toEqual(["Player.train"]);
  expect(t("Run.a", "q.train")).toEqual(["Player.train"]);
  expect(t("Run.b", "c.train")).toEqual(["Car.train"]);
});

suite("C++ range-for", {
  "league.cpp": `#include <vector>
struct Player { void train(); };
struct Car { void train(); };
struct League {
  std::vector<Player> players() { return {}; }
  std::vector<Car> cars() { return {}; }
};
void Player::train() {}
void Car::train() {}
void run(League& league, const std::vector<Player>& squad, std::vector<Car*> fleet) {
  for (auto& p : league.players()) { p.train(); }
  for (const auto& s : squad) { s.train(); }
  for (auto* f : fleet) { f->train(); }
  for (auto& c : league.cars()) { c.train(); }
}
`,
}, (t) => {
  expect(t("run", "p.train")).toEqual(["Player.train"]);
  expect(t("run", "s.train")).toEqual(["Player.train"]);
  expect(t("run", "f.train")).toEqual(["Car.train"]);
  expect(t("run", "c.train")).toEqual(["Car.train"]);
});

suite("Kotlin map destructuring", {
  "League.kt": `package com.example.league
class Player { fun train() {} }
class Club { fun sign() {} }
class Roster(val members: Map<Club, Player>) {
  fun run() {
    for ((club, player) in members) { club.sign(); player.train() }
    for (c in members.keys) { c.sign() }
  }
}
`,
}, (t) => {
  expect(t("Roster.run", "club.sign")).toEqual(["Club.sign"]);
  expect(t("Roster.run", "player.train")).toEqual(["Player.train"]);
  expect(t("Roster.run", "c.sign")).toEqual(["Club.sign"]);
});

suite("Python nested enumerate", {
  "league.py": `class Player:
    def train(self): ...
class Club:
    def sign(self): ...
class Car:
    def train(self): ...
def run(pairs: list[tuple[Club, Player]]):
    for i, (club, player) in enumerate(pairs):
        club.sign()
        player.train()
`,
}, (t) => {
  expect(t("run", "club.sign")).toEqual(["Club.sign"]);
  expect(t("run", "player.train")).toEqual(["Player.train"]);
});

suite("Rust for over a call", {
  "league.rs": `pub struct Player;
impl Player { pub fn train(&self) {} }
pub struct Car;
impl Car { pub fn train(&self) {} }
pub struct Club;
impl Club { pub fn players(&self) -> Vec<Player> { vec![] } }
pub fn run(club: &Club) {
    for p in club.players() {
        p.train();
    }
}
`,
}, (t) => {
  expect(t("run", "p.train")).toEqual(["Player.train"]);
});

describe("collectionElementOf hooks", () => {
  it("reads declared containers and refuses maps and scalars", () => {
    expect(cppCollectionElement("const std::vector<league::Club>&")).toBe("league::Club");
    expect(cppCollectionElement("std::list<std::shared_ptr<Player>>")).toBe("Player");
    expect(cppCollectionElement("std::map<int, Player>")).toBeNull();
    expect(cppCollectionElement("std::vector<int>")).toBeNull();
    expect(phpCollectionElement("Player[]")).toBe("Player");
    expect(phpCollectionElement("array<int, Player>")).toBe("Player");
    expect(phpCollectionElement("array<string, Player>")).toBeNull();
    expect(phpCollectionElement("array")).toBeNull();
    expect(rustCollectionElement("&mut Vec<Player>")).toBe("Player");
    expect(rustCollectionElement("&[Player]")).toBe("Player");
    expect(rustCollectionElement("HashMap<u32, Player>")).toBeNull();
  });
});
