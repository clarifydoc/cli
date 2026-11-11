import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { extractWithRegex } from "./regex-extractor.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";

/**
 * A local assigned from another name (`const q = p`, `q := p`, `$q = $p`, `auto& q = p`, `let q = &p`, `(q := p)`) is
 * typed as the name it came from (`LocalType.aliasOf`). A name bound twice, or from two names, stays untyped, and an
 * alias of an untyped name links to no class of the same method name.
 */
const FILES: Record<string, string> = {
  "ts/league.ts": `export class Player { train(): void {} }
export class Garage { train(): void {} }
export function posAlias(p: Player): void { const q = p; q.train(); }
export function chainAlias(p: Player): void { const q = p; const r = q; r.train(); }
export function fromNew(): void { const p = new Player(); const q = p; q.train(); }
export function negUntyped(p: any): void { const q = p; q.train(); }
export function negReassign(p: Player, g: Garage): void { let q = p; q = g; q.train(); }
export function negTwoHeads(p: Player, g: Garage, c: boolean): void { let q = p; if (c) { q = g; } q.train(); }
export function negUndefined(): void { const q = undefined; q.train(); }
`,
  "go/league.go": `package league

type Player struct{}
func (p *Player) Train() {}
type Garage struct{}
func (g *Garage) Train() {}

func PosAlias(p *Player) { q := p; q.Train() }
func PosAddr() { p := Player{}; q := &p; q.Train() }
func NegUntyped(p interface{}) { q := p; q.Train() }
func NegReassign(p *Player, g *Garage) { q := p; q = nil; _ = g; q.Train() }
func NegMulti(p *Player, g *Garage) { q := p; var err error; q, err = g, nil; _ = err; q.Train() }
`,
  "php/League.php": `<?php
class Player { public function train() {} }
class Garage { public function train() {} }
function posAlias(Player $p) { $q = $p; $q->train(); }
function negUntyped($p) { $q = $p; $q->train(); }
function negReassign(Player $p, Garage $g) { $q = $p; $q = $g; $q->train(); }
function negForeach(Player $p, array $gs) { $q = $p; foreach ($gs as $q) { $q->train(); } }
`,
  "cpp/league.cpp": `struct Player { void train() {} };
struct Garage { void train() {} };
void posAlias(Player& p) { auto& q = p; q.train(); }
void posPtr(Player* p) { auto* q = p; q->train(); }
void negUntyped(auto& p) { auto& q = p; q.train(); }
void negReassign(Player* p, Garage* g) { auto* q = p; q = g; q->train(); }
`,
  "rs/league.rs": `pub struct Player;
impl Player { pub fn train(&self) {} }
pub struct Garage;
impl Garage { pub fn train(&self) {} }
pub fn pos_alias(p: Player) { let q = p; q.train(); }
pub fn pos_ref(p: &Player) { let q = &p; q.train(); }
pub fn neg_untyped(p: impl Sized) { let q = p; q.train(); }
pub fn neg_two(p: Player, g: Garage, c: bool) { let mut q = p; if c { q = g; } q.train(); }
`,
  "py/league.py": `class Player:
    def train(self): ...
class Garage:
    def train(self): ...
def make_player() -> Player: ...
def pos_alias(p: Player):
    q = p
    q.train()
def pos_from():
    p = make_player()
    q = p
    q.train()
def pos_walrus():
    p = make_player()
    if (q := p):
        q.train()
def neg_untyped(p):
    q = p
    q.train()
def pos_walrus_new():
    if (q := Player()):
        q.train()
def neg_two(p: Player, g: Garage):
    q = p
    q = g
    q.train()
`,
};

describe("alias of a typed local", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-alias-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => /train/i.test(l.callName)).map((l) => `${l.sourceSymbol} -> ${l.targetFile.split("/")[0]}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ["ts", ["posAlias", "chainAlias", "fromNew"], "Player.train"],
    ["go", ["PosAlias", "PosAddr"], "Player.Train"],
    ["php", ["posAlias"], "Player.train"],
    ["cpp", ["posAlias", "posPtr"], "Player.train"],
    ["rs", ["pos_alias", "pos_ref"], "Player.train"],
    ["py", ["pos_alias", "pos_from", "pos_walrus", "pos_walrus_new"], "Player.train"],
  ])("%s: an alias is the class of the name it came from", (lang, callers, target) => {
    for (const caller of callers) expect(links).toContain(`${caller} -> ${lang}::${target}`);
  });

  it("an untyped, reassigned or two-headed alias links to no class", () => {
    const wrong = links.filter((l) => /^(neg|Neg)/.test(l));
    expect(wrong).toEqual([]);
    expect(links.filter((l) => l.includes("Garage."))).toEqual([]);
  });
});

describe("an initializer that goes on past its line (real-repo FP)", () => {
  beforeAll(async () => {
    await ensureLanguagesLoaded(["rust", "cpp"]);
  });
  it("is no alias in Rust or C++", () => {
    const rust = extractWithRegex(
      "pub async fn kickoff(league: League) {\n  let club = league\n    .clubs\n    .first()\n    .unwrap();\n  club.sign();\n}\n",
      "src/lib.rs", "rust",
    );
    expect(rust.functions.flatMap((f) => f.localTypes ?? []).filter((l) => l.aliasOf)).toEqual([]);
    const cpp = extractWithRegex("void kickoff(League& league) {\n  auto club = league\n    .first();\n  club.sign();\n}\n", "src/match.cpp", "cpp");
    expect(cpp.functions.flatMap((f) => f.localTypes ?? []).filter((l) => l.aliasOf)).toEqual([]);
  });
});
