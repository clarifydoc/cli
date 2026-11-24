/**
 * A dotted call of an internal name whose last name no file declares is refused before its receiver is walked;
 * a dispatch map's key, which no file declares, still reaches the function the map holds.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "./file-analyzer.js";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, Language } from "../types/analysis.js";

async function analyzeAll(files: Record<string, string>, language: Language): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "undeclared-leaf-"));
  const out = await mkdtemp(join(tmpdir(), "undeclared-leaf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

describe("a dotted call naming nothing the project declares", () => {
  it("links the declared member, refuses the library's, and keeps a dispatch map's key", async () => {
    const analyses = await analyzeAll({
      "src/club.ts": [
        "export class Club {",
        "  sign(): void {}",
        "}",
        "export function signClub(): void {}",
      ].join("\n"),
      "src/desk.ts": [
        'import { Club, signClub } from "./club";',
        "const handlers = { enlist: signClub };",
        "export function run(club: Club, rows: string[]) {",
        "  club.sign();",
        "  club.release();",
        "  rows.join(',');",
        "  handlers.enlist();",
        "}",
      ].join("\n"),
    }, "typescript");
    const links = buildSymbolLinks(analyses)
      .filter((l) => l.sourceFile === "src/desk.ts" && l.sourceSymbol === "run")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
    expect(links).toEqual(["club.sign -> src/club.ts::Club.sign", "handlers.enlist -> src/club.ts::signClub"]);
  });
});
