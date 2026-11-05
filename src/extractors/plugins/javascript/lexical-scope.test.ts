import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-js-lexical-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir, done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetFile}:${l.targetSymbol}`);

describe("a parameter of a call's name is what the call reaches", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "pit.ts": `export function save(n: number) { return n; }
export function run(save: (n: number) => void) { save(1); }
export function pick({ save }: { save: () => void }) { save(); }
export function direct() { save(2); }
export class Club {}
export function build(Club: any) { return new Club(); }
`,
    }));
  });
  afterAll(async () => done());

  it("links a call of a parameter, plain or destructured, to nothing", () => {
    expect(targets(summary, "run", "save")).toEqual([]);
    expect(targets(summary, "pick", "save")).toEqual([]);
  });
  it("still links the module's own function where no parameter shadows it", () => {
    expect(targets(summary, "direct", "save")).toEqual(["pit.ts:save"]);
  });
});

describe("a `require` naming its module is no call", () => {
  let dir: string;
  let done: () => Promise<void>;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    ({ summary, dir, done } = await scan({
      "x.js": "exports.start = function () { return 1; };\n",
      "main.js": `function boot() {
  require('./x').start();
  const y = require('./x');
  y.start();
}
function lazy(name) {
  return require(name);
}
boot();
`,
    }));
  });
  afterAll(async () => done());

  it("keeps the member call, the binding's call and a dynamic require, and drops the literal ones", async () => {
    const { readFile } = await import("fs/promises");
    const file = JSON.parse(await readFile(join(dir, "out", "main.js.json"), "utf-8")) as { functions: Array<{ name: string; calls: Array<{ name: string }> }> };
    const named = (fn: string) => file.functions.find((f) => f.name === fn)!.calls.map((c) => c.name).sort();
    expect(named("boot")).toEqual(["start", "y.start"]);
    expect(named("lazy")).toEqual(["require"]);
    expect(targets(summary, "boot", "start")).toEqual(["x.js:start"]);
  });
});
