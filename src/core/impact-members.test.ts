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
