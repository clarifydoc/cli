import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyzeFile } from "./file-analyzer.js";
import { fileAnalysisPath, writeFileAnalysis, writeOutputFilesSync } from "./output-writer.js";

/**
 * A file's JSON is written where it is analyzed, or handed back as bytes for
 * the caller to write later (`deferWrite`): the bytes are the same either way,
 * and a batch that cannot be written names the files it left out.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function analyzeClub(out: string, deferWrite: boolean) {
  const root = await scratch("clarifydoc-output-src-");
  const rel = "league/clubs/club.ts";
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), "export function promote(club: string): string {\n  return relegate(club);\n}\nfunction relegate(club: string): string {\n  return club;\n}\n");
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "typescript" },
    frameworkIds: [], projectId: "root", outputOpts: { outputDir: out, pretty: false },
    verbose: false, projectRoot: root, tsconfigAliases: new Map(),
    ...(deferWrite ? { deferWrite: true } : {}),
  } as never);
  return { rel, result: result! };
}

describe("per-file output", () => {
  it("writes a file's JSON into a directory that is not there yet", async () => {
    const out = await scratch("clarifydoc-output-");
    const { rel, result } = await analyzeClub(out, false);
    expect(result.json).toBeUndefined();
    const written = JSON.parse(readFileSync(fileAnalysisPath(rel, { outputDir: out }), "utf-8"));
    expect(written.filePath).toBe(rel);
    expect(written.functions.map((f: { name: string }) => f.name)).toEqual(["promote", "relegate"]);
    // Again, over the file that is there now.
    await writeFileAnalysis(result.analysis, { outputDir: out });
    expect(JSON.parse(readFileSync(fileAnalysisPath(rel, { outputDir: out }), "utf-8")).filePath).toBe(rel);
  });

  it("hands the same bytes back, unwritten, when the caller writes", async () => {
    const out = await scratch("clarifydoc-output-");
    const written = await analyzeClub(out, false);
    const deferredOut = await scratch("clarifydoc-output-");
    const deferred = await analyzeClub(deferredOut, true);
    expect(existsSync(fileAnalysisPath(deferred.rel, { outputDir: deferredOut }))).toBe(false);
    const text = new TextDecoder().decode(deferred.result.json);
    expect(JSON.parse(text)).toEqual({
      ...JSON.parse(readFileSync(fileAnalysisPath(written.rel, { outputDir: out }), "utf-8")),
      analyzedAt: JSON.parse(text).analyzedAt,
    });

    const path = fileAnalysisPath(deferred.rel, { outputDir: deferredOut });
    expect(writeOutputFilesSync([{ key: deferred.rel, path, data: deferred.result.json! }])).toEqual({ unwritten: [] });
    expect(readFileSync(path, "utf-8")).toBe(text);
  });

  it("names the files of a batch it could not write and writes the rest", async () => {
    const out = await scratch("clarifydoc-output-");
    await writeFile(join(out, "stadium"), "");
    const data = new TextEncoder().encode("{}");
    const result = writeOutputFilesSync([
      { key: "match.ts", path: join(out, "fixtures", "match.ts.json"), data },
      // Its directory is a file.
      { key: "pitch.ts", path: join(out, "stadium", "pitch.ts.json"), data },
      // Bytes that went to a worker that died come back empty.
      { key: "referee.ts", path: join(out, "fixtures", "referee.ts.json"), data: new Uint8Array(0) },
      { key: "player.ts", path: join(out, "fixtures", "squad", "player.ts.json"), data },
    ]);
    expect(result.unwritten.map((u) => u.key)).toEqual(["pitch.ts", "referee.ts"]);
    expect(readFileSync(join(out, "fixtures", "match.ts.json"), "utf-8")).toBe("{}");
    expect(readFileSync(join(out, "fixtures", "squad", "player.ts.json"), "utf-8")).toBe("{}");
    expect(existsSync(join(out, "fixtures", "referee.ts.json"))).toBe(false);
  });
});
