import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { updateLsp } from "../core/lsp-updater.js";
import { decodeLsif, lsifAnswers } from "./lsif.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";

/** An LSIF writer: a document per file, a use range chained to a result set, a definition result naming the defining range. */
function dump(
  root: string,
  uses: Array<{ file: string; line0: number; col: number; defFile: string | null; defLine0: number }>,
  asArray = false,
  positionEncoding?: string,
): string {
  let id = 1;
  const out: object[] = [{
    id: id++,
    type: "vertex",
    label: "metaData",
    version: "0.4.3",
    projectRoot: root,
    toolInfo: { name: "lsif-tsc" },
    ...(positionEncoding !== undefined ? { positionEncoding } : {}),
  }];
  const docs = new Map<string, number>();
  const doc = (file: string) => {
    if (!docs.has(file)) {
      docs.set(file, id);
      out.push({ id: id++, type: "vertex", label: "document", uri: `${root}/${file}`, languageId: "typescript" });
    }
    return docs.get(file)!;
  };
  for (const u of uses) {
    const use = id++;
    out.push({ id: use, type: "vertex", label: "range", start: { line: u.line0, character: u.col }, end: { line: u.line0, character: u.col + 4 } });
    out.push({ id: id++, type: "edge", label: "contains", outV: doc(u.file), inVs: [use] });
    const set = id++;
    out.push({ id: set, type: "vertex", label: "resultSet" });
    out.push({ id: id++, type: "edge", label: "next", outV: use, inV: set });
    if (!u.defFile) continue;
    const def = id++;
    out.push({ id: def, type: "vertex", label: "range", start: { line: u.defLine0, character: 9 }, end: { line: u.defLine0, character: 13 } });
    out.push({ id: id++, type: "edge", label: "contains", outV: doc(u.defFile), inVs: [def] });
    const result = id++;
    out.push({ id: result, type: "vertex", label: "definitionResult" });
    out.push({ id: id++, type: "edge", label: "textDocument/definition", outV: set, inV: result });
    out.push({ id: id++, type: "edge", label: "item", outV: result, inVs: [def], document: doc(u.defFile) });
  }
  return asArray ? JSON.stringify(out) : out.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("lsifAnswers", () => {
  const q = (file: string, line: number, column: number): DefinitionQuery => ({ file, line, column, callName: "run", language: "typescript" });

  it("follows a use through its result set to the defining range, in lines or an array, with no target outside the analysis", () => {
    for (const asArray of [false, true]) {
      const d = decodeLsif(dump("file:///repo", [
        { file: "src/a.ts", line0: 4, col: 2, defFile: "src/b.ts", defLine0: 9 },
        { file: "src/a.ts", line0: 6, col: 0, defFile: "node_modules/x/index.d.ts", defLine0: 1 },
      ], asArray));
      const out = lsifAnswers(d, [q("src/a.ts", 5, 3), q("src/a.ts", 7, 1), q("src/a.ts", 5, 9)], new Set(["src/a.ts", "src/b.ts"]));
      expect(out).toEqual({
        source: "lsif",
        servers: ["lsif-tsc"],
        answers: [
          { file: "src/a.ts", line: 5, column: 3, targets: [{ file: "src/b.ts", line: 10 }] },
          { file: "src/a.ts", line: 7, column: 1, targets: [] },
        ],
      });
    }
  });

  describe("position encoding", () => {
    // `const club = "⚽🏆"; run()` — two football emoji (2 UTF-16 units, 4 UTF-8 bytes, 1 code point each) before the call.
    const line = 'const club = "\u26bd\u{1f3c6}"; run()';
    const utf16At = line.indexOf("run");
    const bytesAt = Buffer.byteLength(line.slice(0, utf16At), "utf8");
    const pointsAt = [...line.slice(0, utf16At)].length;
    const files = new Set(["src/a.ts", "src/b.ts"]);
    const hit = [{ file: "src/a.ts", line: 1, column: utf16At, targets: [{ file: "src/b.ts", line: 10 }] }];
    const lineText = (p: string, l: number) => (p === "src/a.ts" && l === 0 ? line : undefined);
    const run = (enc: string | undefined, col: number) =>
      decodeLsif(dump("file:///repo", [{ file: "src/a.ts", line0: 0, col, defFile: "src/b.ts", defLine0: 9 }], false, enc));

    it("reads metaData.positionEncoding", () => {
      expect(run("utf-8", 0).positionEncoding).toBe("utf8");
      expect(run("utf-32", 0).positionEncoding).toBe("utf32");
      expect(run("utf-16", 0).positionEncoding).toBe("utf16");
      expect(run(undefined, 0).positionEncoding).toBeUndefined();
    });

    it("converts UTF-8 byte offsets to the query's UTF-16 columns from the project file", () => {
      expect(bytesAt).not.toBe(utf16At);
      expect(lsifAnswers(run("utf-8", bytesAt), [q("src/a.ts", 1, utf16At)], files, lineText).answers).toEqual(hit);
      // The byte offset taken as UTF-16 would miss.
      expect(lsifAnswers(run(undefined, bytesAt), [q("src/a.ts", 1, utf16At)], files, lineText).answers).toEqual([]);
    });

    it("converts UTF-32 offsets (code points)", () => {
      expect(pointsAt).not.toBe(utf16At);
      expect(lsifAnswers(run("utf-32", pointsAt), [q("src/a.ts", 1, utf16At)], files, lineText).answers).toEqual(hit);
    });

    it("leaves UTF-16 and unspecified dumps as they are (ASCII-identical)", () => {
      expect(lsifAnswers(run("utf-16", utf16At), [q("src/a.ts", 1, utf16At)], files, lineText).answers).toEqual(hit);
      expect(lsifAnswers(run(undefined, utf16At), [q("src/a.ts", 1, utf16At)], files).answers).toEqual(hit);
    });
  });
});

const fixture = resolve("test-fixtures/sample-backend");
const analysis = resolve("test-output/sample-backend");

describe.skipIf(!existsSync(join(analysis, "project-summary.json")))("lsp-update --lsif", () => {
  let dir: string;
  let queries: DefinitionQuery[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-lsif-"));
    await cp(analysis, join(dir, "an"), { recursive: true });
    await rm(join(dir, "an", "lsp-enhancement.json"), { force: true });
    await rm(join(dir, "an", "lsp-ground-truth.json"), { force: true });
    await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, emitQueries: join(dir, "q.json") });
    queries = JSON.parse(await readFile(join(dir, "q.json"), "utf-8")).queries;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns the dump's definitions into layer-2 links, built one directory above the analysis root", async () => {
    const one = queries[0]!;
    await writeFile(join(dir, "dump.lsif"), dump("file:///work", [{ file: `sample-backend/${one.file}`, line0: one.line - 1, col: one.column, defFile: "sample-backend/routes/players.ts", defLine0: 13 }]));
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, lsif: join(dir, "dump.lsif") });
    expect(r).toMatchObject({ source: "lsif", serversUsed: ["lsif-tsc"], lspResolvedCount: 1 });
    const enh = JSON.parse(await readFile(join(dir, "an", "lsp-enhancement.json"), "utf-8"));
    const added = enh.symbolLinks.filter((l: { resolvedBy?: string }) => l.resolvedBy === "lsp");
    expect(added).toEqual([expect.objectContaining({ sourceFile: one.file, sourceLine: one.line, targetFile: "routes/players.ts", targetLine: 14 })]);
  });
});
