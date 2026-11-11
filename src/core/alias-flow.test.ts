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
    expect(links.filter((l) => l.includes("Garage.train"))).toEqual([]);
  });

  it("follows a receiver chain of four calls, never into a namesake", () => {
    expect(links).toContain("fourHops -> Agent.contract");
    expect(links.filter((l) => l.includes("Fake"))).toEqual([]);
  });
});
