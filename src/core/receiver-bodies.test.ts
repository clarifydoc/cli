import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** Calls in a Java enum constant's body, and C++ operators and forward declarations, each beside a same-named decoy. */
describe("calls in enum constant bodies and operator expressions", () => {
  let root: string;
  let java: ProjectAnalysis;
  let cpp: ProjectAnalysis;
  const run = async (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    await analyze({ projectRoot: dir, outputDir: join(root, `${name}-out`), lsp: false, gitHistory: false });
    return loadReportSummary(join(root, `${name}-out`));
  };
  const links = (a: ProjectAnalysis) => (a.symbolLinks ?? []).map((l) => `${l.sourceSymbol}>${l.targetFile.split("/").pop()}:${l.targetSymbol}`).sort();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-bodies-"));
    java = await run("java", {
      "Coach.java": "package com.example.league;\npublic class Coach { public void shout() {} }\n",
      "Referee.java": "package com.example.league;\npublic class Referee { public void shout() {} }\n",
      "Formation.java": `package com.example.league;
public enum Formation {
  ATTACK { void play() { coach.shout(); } },
  DEFEND { void play() { } };
  Coach coach;
  abstract void play();
}
`,
    });
    cpp = await run("cpp", {
      "main.cpp": `class Club;
class Player { public: Player operator+(const Player& o) const; };
class Car { public: Car operator+(const Car& o) const; };
struct Kit { int n; };
Kit operator+(const Kit& a, const Kit& b);
void tally(Player a, Player b, Car c, Car d, Kit k, Kit m, int x, int y, Player* p, size_t n, uint16_t q) {
  Player s = a + b;
  Car t = c + d;
  Kit u = k + m;
  int z = x + y;
  Player w = p + 1;
  size_t half = n * 2 + q * 3;
  bool same = k == m;
}
void Club::sign() { tally(); }
void audit(Club* c) { c->sign(); }
Player Player::operator+(const Player& o) const { return o; }
Car Car::operator+(const Car& o) const { return o; }
Kit operator+(const Kit& a, const Kit& b) { return a; }
bool operator==(const Kit& a, const Kit& b) { return a.n == b.n; }
bool operator==(const Kit& a, int b) { return a.n == b; }
struct Iter { int operator*() const { return 0; } };
`,
    });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("owns the calls of an enum constant's override by the enum's method", () => {
    expect(links(java)).toContain("Formation.play>Coach.java:Coach.shout");
    expect(links(java).filter((l) => l.includes("Referee"))).toEqual([]);
  });

  it("links an operator expression to the operator of its left operand's class, never a primitive's, a `_t` number's, a pointer's, or one of a free overload set (real-repo FP)", () => {
    const l = links(cpp).filter((x) => x.startsWith("tally>"));
    expect(l).toEqual(["tally>main.cpp:Car.operator+", "tally>main.cpp:Player.operator+", "tally>main.cpp:operator+"]);
  });

  it("links a call on a forward-declared class to its out-of-line definition", () => {
    expect(links(cpp)).toContain("audit>main.cpp:Club.sign");
  });
});
