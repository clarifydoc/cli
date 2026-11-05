import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A value typed by a type parameter is typed by its bound: `fn f<T extends Club>(x: T) { x.promote() }`. */
describe("type-parameter bounds as receiver types, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-bounds-"));
    const ts = join(dir, "ts");
    const py = join(dir, "py");
    await mkdir(ts, { recursive: true });
    await mkdir(py, { recursive: true });
    await writeFile(join(ts, "club.ts"), "export class Club { promote(): void {} }\nexport class Car { promote(): void {} }\n");
    await writeFile(join(ts, "use.ts"), [
      'import { Club } from "./club";',
      "export function f<T extends Club>(x: T) { x.promote(); }",
      "export class Box<T extends Club> {",
      "  constructor(private item: T) {}",
      "  run(y: T) { y.promote(); this.item.promote(); }",
      "}",
      "export const g = <T extends Club>(z: T) => { z.promote(); };",
      "export function plain<T>(w: T) { w.promote(); }",
    ].join("\n"));
    await writeFile(join(py, "club.py"), "class Club:\n    def promote(self): pass\n");
    await writeFile(join(py, "car.py"), "class Car:\n    def promote(self): pass\n");
    await writeFile(join(py, "use.py"), [
      "from typing import TypeVar",
      "from club import Club",
      'T = TypeVar("T", bound=Club)',
      'U = TypeVar("U", bound="Club")',
      "def f(x: T):",
      "    x.promote()",
      "def h(x: U):",
      "    x.promote()",
      "def k[V: Club](x: V):",
      "    x.promote()",
      "class Box[W: Club]:",
      "    def run(self, y: W):",
      "        y.promote()",
      "def plain(z):",
      "    z.promote()",
    ].join("\n"));
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const targets = async (file: string, symbol: string) => {
    const summary = await loadReportSummary(join(dir, "out"));
    return (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === file && l.sourceSymbol === symbol && /promote$/.test(l.callName ?? ""))
      .map((l) => `${l.targetFile}:${l.targetSymbol}`);
  };

  it.each(["f", "g", "Box.run"])("TypeScript %s reaches the bound's member, never the namesake", async (symbol) => {
    const found = await targets("ts/use.ts", symbol);
    expect(found).toContain("ts/club.ts:Club.promote");
    expect(found.some((t) => t.includes("Car"))).toBe(false);
  });

  it("TypeScript leaves an unbounded type parameter unlinked", async () => {
    expect(await targets("ts/use.ts", "plain")).toEqual([]);
  });

  it.each(["f", "h", "k", "Box.run"])("Python %s reaches the bound's member, never the namesake", async (symbol) => {
    const found = await targets("py/use.py", symbol);
    expect(found).toContain("py/club.py:Club.promote");
    expect(found.some((t) => t.includes("Car"))).toBe(false);
  });
});
