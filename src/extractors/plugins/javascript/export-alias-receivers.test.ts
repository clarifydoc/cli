import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const FILES: Record<string, string> = {
  "package.json": `{"name":"league"}`,
  "src/club.ts": `export class Club { sign(): void {} }\nexport { Club as Squad };\nexport default class Side { tackle(): void {} }\n`,
  // The decoy: same member name, never reached.
  "src/car.ts": `export class Car { sign(): void {} }\n`,
  "src/barrel.ts": `export { Squad as Team } from "./club";\nexport { Squad } from "./club";\nexport { default as Eleven } from "./club";\n`,
  "src/use.ts": `import { Squad } from "./club";
export function typed(s: Squad) { s.sign(); }
export function narrowed(v: unknown) { if (v instanceof Squad) v.sign(); }
export function built() { const q = new Squad(); q.sign(); }
`,
  "src/use2.ts": `import { Team, Squad as Reserve, Eleven } from "./barrel";
export function viaAlias(t: Team) { t.sign(); }
export function viaRename(t: Reserve) { t.sign(); }
export function viaDefault(t: Eleven) { t.tackle(); }
`,
};

describe("a receiver typed by a name its module exports under an alias", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-export-alias-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "p", rel)), { recursive: true });
      await writeFile(join(dir, "p", rel), text);
    }
    await analyze({ projectRoot: join(dir, "p"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const at = (file: string, name: string) =>
    summary.symbolLinks.filter((l) => l.sourceFile === file && l.callName === name).map((l) => `${l.targetFile}:${l.targetLine}`);

  it("reaches the class's members through a parameter, a type test, a barrel alias and a default alias", () => {
    expect(at("src/use.ts", "s.sign")).toEqual(["src/club.ts:1"]);
    expect(at("src/use.ts", "v.sign")).toEqual(["src/club.ts:1"]);
    expect(at("src/use.ts", "q.sign")).toEqual(["src/club.ts:1"]);
    expect(at("src/use2.ts", "t.sign")).toEqual(["src/club.ts:1", "src/club.ts:1"]);
    expect(at("src/use2.ts", "t.tackle")).toEqual(["src/club.ts:3"]);
  });

  it("links the constructor and the type reference to the class, not the alias row, and never to the decoy", () => {
    expect(at("src/use.ts", "Squad").sort()).toEqual(["src/club.ts:1", "src/club.ts:1"]);
    expect(summary.symbolLinks.filter((l) => l.targetFile === "src/car.ts")).toEqual([]);
  });
});
