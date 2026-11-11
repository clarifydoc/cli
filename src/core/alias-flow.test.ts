import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * An alias is typed by the name it came from AS BOUND AT THE ALIAS (`const q = p` after `p = new Player()` and before
 * `p = new Garage()` is a Player), and a receiver chain of four calls is followed (`LocalType.aliasOf`,
 * `MAX_RECEIVER_CHAIN`).
 */
const FILES: Record<string, string> = {
  "ts/flow.ts": `export class Player { train(): void {} }
export class Garage { train(): void {} }
export function afterReassign(): void {
  let p: Player = new Player();
  const q = p;
  p = new Garage() as any;
  q.train();
}
export function beforeReassign(): void {
  let p: Garage = new Garage();
  p = new Player();
  const q = p;
  q.train();
}
export function negNestedBefore(c: boolean): void {
  let p = new Garage();
  if (c) { p = new Player(); }
  const q = p;
  q.train();
}
export function negUntypedBefore(x: any): void {
  let p = x;
  const q = p;
  p = new Player();
  q.train();
}
export function negLoop(items: Garage[]): void {
  let p = new Player();
  for (const g of items) {
    const q = p;
    p = g;
    q.train();
  }
}
`,
  "py/flow.py": `class Player:
    def train(self):
        pass


class Garage:
    def train(self):
        pass


def make(x):
    return x


def py_after_reassign():
    p = Garage()
    p = Player()
    q = p
    q.train()


def py_alias_before_reassign():
    p = Garage()
    q = p
    p = Player()
    q.train()


def neg_py_untyped_before(x):
    p = Garage()
    p = make(x)
    q = p
    q.train()


def neg_py_nested_before(c):
    p = Garage()
    if c:
        p = Player()
    q = p
    q.train()

`,
  "php/flow.php": `<?php
class Player { public function train(): void {} }
class Garage { public function train(): void {} }
function phpAfterReassign(): void {
    $p = new Garage();
    $p = new Player();
    $q = $p;
    $q->train();
}
function negPhpUntypedBefore($x): void {
    $p = new Garage();
    $p = $x->load();
    $q = $p;
    $q->train();
}
function negPhpNestedBefore(bool $c): void {
    $p = new Garage();
    if ($c) { $p = new Player(); }
    $q = $p;
    $q->train();
}
function negPhpLoop(array $items): void {
    $p = new Player();
    foreach ($items as $g) {
        $q = $p;
        $p = new Garage();
        $q->train();
    }
}
`,
  "rs/flow.rs": `pub struct Player;
impl Player { pub fn new() -> Player { Player } pub fn train(&self) {} }
pub struct Garage;
impl Garage { pub fn new() -> Garage { Garage } pub fn train(&self) {} }
pub fn rs_after_reassign() {
    let mut p = Garage::new();
    p = Player::new();
    let q = &p;
    q.train();
}
pub fn rs_shadowed() {
    let p = Garage::new();
    let p = Player::new();
    let q = p;
    q.train();
}
pub fn neg_rs_untyped_before(x: Option<Player>) {
    let mut p = Garage::new();
    p = x.unwrap_or_default();
    let q = &p;
    q.train();
}
pub fn neg_rs_if_let(o: Option<u8>) {
    let mut p = Garage::new();
    if let Some(_x) = o { p = Player::new(); }
    let q = &p;
    q.train();
}
pub fn neg_rs_nested_before(c: bool) {
    let mut p = Garage::new();
    if c { p = Player::new(); }
    let q = &p;
    q.train();
}
pub fn neg_rs_loop(items: Vec<u8>) {
    let mut p = Player::new();
    for _g in items {
        let q = &p;
        p = Garage::new();
        q.train();
    }
}
`,
  "cpp/flow.cpp": `struct Player { void train() {} };
struct Garage { void train() {} };
void cppAfterReassign() {
  { Garage p; }
  Player p;
  auto& q = p;
  q.train();
}
void negCppBraceless(bool c) {
  Garage* p = new Garage();
  if (c) p = new Player();
  auto q = p;
  q->train();
}
void negCppNestedBefore() {
  Player p;
  { Garage p; }
  auto& q = p;
  q.train();
}
`,
  "ts/chain.ts": `export class Contract { sign(): void {} }
export class Agent { contract(): Contract { return new Contract(); } }
export class Captain { agent(): Agent { return new Agent(); } }
export class Squad { captain(): Captain { return new Captain(); } }
export class Club { squad(): Squad { return new Squad(); } }
export class League { club(): Club { return new Club(); } }
export class FakeContract { sign(): void {} }
export class FakeAgent { contract(): FakeContract { return new FakeContract(); } }
export class FakeCaptain { agent(): FakeAgent { return new FakeAgent(); } }
export class FakeSquad { captain(): FakeCaptain { return new FakeCaptain(); } }
export function fourHops(l: League): void { l.club().squad().captain().agent().contract(); }
export function negUntypedHead(x: any): void { x.club().squad().captain().agent().contract(); }
`,
};

describe("alias flow order and four-call chains", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-alias-flow-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => /train|contract/.test(l.callName)).map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types an alias by its head as bound at the alias", () => {
    expect(links).toContain("afterReassign -> Player.train");
    expect(links).toContain("beforeReassign -> Player.train");
  });

  it("leaves an alias untyped when the head's binding before it is nested, untyped or in a loop", () => {
    expect(links.filter((l) => /^neg/.test(l))).toEqual([]);
    expect(links.filter((l) => l.includes("Garage.train") && !l.startsWith("py_"))).toEqual([]);
  });

  it("follows flow order for aliases in Python, PHP, Rust and C++", () => {
    expect(links).toContain("py_after_reassign -> Player.train");
    expect(links).toContain("py_alias_before_reassign -> Garage.train");
    expect(links).toContain("phpAfterReassign -> Player.train");
    expect(links).toContain("rs_after_reassign -> Player.train");
    expect(links).toContain("rs_shadowed -> Player.train");
    expect(links).toContain("cppAfterReassign -> Player.train");
  });

  it("leaves an alias untyped in the other languages when the head's binding is nested, untyped or in a loop", () => {
    expect(links.filter((l) => /^neg/.test(l))).toEqual([]);
  });

  it("follows a receiver chain of four calls, never into a namesake", () => {
    expect(links).toContain("fourHops -> Agent.contract");
    expect(links.filter((l) => l.includes("Fake"))).toEqual([]);
  });
});
