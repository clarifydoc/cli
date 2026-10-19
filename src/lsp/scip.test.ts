import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { updateLsp } from "../core/lsp-updater.js";
import { decodeScip, scipAnswers, scipPathMapper } from "./scip.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";

// A protobuf writer for the handful of fields an index needs.
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const bytes = (field: number, b: number[]) => [...tag(field, 2), ...varint(b.length), ...b];
const str = (field: number, s: string) => bytes(field, [...new TextEncoder().encode(s)]);
const int = (field: number, n: number) => [...tag(field, 0), ...varint(n)];

interface Occ {
  range: number[];
  symbol: string;
  def?: boolean;
}
const occurrence = (o: Occ) => [...bytes(1, o.range.flatMap(varint)), ...str(2, o.symbol), ...(o.def ? int(3, 1) : [])];
const doc = (path: string, occs: Occ[]) => [...str(1, path), ...occs.flatMap((o) => bytes(2, occurrence(o)))];
const index = (docs: Array<[string, Occ[]]>, root = "file:///repo") =>
  new Uint8Array([
    ...bytes(1, [...bytes(2, str(1, "scip-typescript")), ...str(3, root)]),
    ...docs.flatMap(([p, o]) => bytes(2, doc(p, o))),
    // An unknown field is skipped.
    ...str(9, "ignored"),
  ]);

describe("decodeScip", () => {
  it("reads the metadata, documents and occurrences, packed or not", () => {
    const decoded = decodeScip(index([["src/a.ts", [{ range: [3, 4, 9], symbol: "npm pkg 1.0 src/b.ts/run().", def: false }, { range: [0, 9, 1, 2], symbol: "local 0", def: true }]]]));
    expect(decoded.tool).toBe("scip-typescript");
    expect(decoded.projectRoot).toBe("file:///repo");
    expect(decoded.documents).toEqual([
      { path: "src/a.ts", occurrences: [{ range: [3, 4, 9], symbol: "npm pkg 1.0 src/b.ts/run().", roles: 0 }, { range: [0, 9, 1, 2], symbol: "local 0", roles: 1 }] },
    ]);
  });

  it("refuses a truncated index rather than guessing", () => {
    const whole = index([["src/a.ts", [{ range: [1, 2, 3], symbol: "x" }]]]);
    expect(() => decodeScip(whole.subarray(0, whole.length - 12))).toThrow();
  });
});

describe("scipAnswers", () => {
  const q = (file: string, line: number, column: number): DefinitionQuery => ({ file, line, column, callName: "run", language: "typescript" });
  const RUN = "scip-typescript npm app 1.0 src/`b.ts`/run().";

  it("answers a question with the occurrence that defines the symbol at its position", () => {
    const idx = decodeScip(index([
      ["src/a.ts", [{ range: [4, 2, 5], symbol: RUN }, { range: [6, 0, 3], symbol: "local 1" }, { range: [2, 6, 9], symbol: "local 1", def: true }]],
      ["src/b.ts", [{ range: [9, 16, 19], symbol: RUN, def: true }]],
    ]));
    const out = scipAnswers(idx, [q("src/a.ts", 5, 3), q("src/a.ts", 7, 1), q("src/a.ts", 5, 9), q("src/z.ts", 1, 0)]);
    expect(out.source).toBe("scip");
    expect(out.servers).toEqual(["scip-typescript"]);
    expect(out.answers).toEqual([
      { file: "src/a.ts", line: 5, column: 3, targets: [{ file: "src/b.ts", line: 10 }] },
      // A local symbol resolves within its own document.
      { file: "src/a.ts", line: 7, column: 1, targets: [{ file: "src/a.ts", line: 3 }] },
    ]);
  });

  it("gives no target for a symbol defined outside the index (a dependency)", () => {
    const idx = decodeScip(index([["src/a.ts", [{ range: [0, 0, 3], symbol: "scip-typescript npm express 4.0 `index.d.ts`/Router()." }]]]));
    expect(scipAnswers(idx, [q("src/a.ts", 1, 1)]).answers).toEqual([{ file: "src/a.ts", line: 1, column: 1, targets: [] }]);
  });

  it("maps an index built above or below the analysis root", () => {
    const files = new Set(["src/a.ts", "src/b.ts"]);
    const above = decodeScip(index([["web/src/a.ts", []], ["web/src/b.ts", []], ["api/x.ts", []]])).documents;
    const strip = scipPathMapper(above, files);
    expect([strip("web/src/a.ts"), strip("api/x.ts")]).toEqual(["src/a.ts", null]);
    const below = decodeScip(index([["a.ts", []], ["b.ts", []]])).documents;
    expect(scipPathMapper(below, files)("b.ts")).toBe("src/b.ts");
    expect(scipPathMapper(decodeScip(index([["src/a.ts", []]])).documents, files)("src/a.ts")).toBe("src/a.ts");
  });
});

const fixture = resolve("test-fixtures/sample-backend");
const analysis = resolve("test-output/sample-backend");

describe.skipIf(!existsSync(join(analysis, "project-summary.json")))("lsp-update --scip", () => {
  let dir: string;
  let queries: DefinitionQuery[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-scip-"));
    await cp(analysis, join(dir, "an"), { recursive: true });
    await rm(join(dir, "an", "lsp-enhancement.json"), { force: true });
    await rm(join(dir, "an", "lsp-ground-truth.json"), { force: true });
    await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, emitQueries: join(dir, "q.json") });
    queries = JSON.parse(await readFile(join(dir, "q.json"), "utf-8")).queries;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("turns the index's definitions into layer-2 links", async () => {
    const [one, two] = queries;
    const sym = (s: string) => `scip-typescript npm sample 1.0 ${s}`;
    const at = (x: DefinitionQuery) => [x.line - 1, x.column, x.column + 1];
    // Built one directory above the analysis root: the paths carry a prefix.
    const occs: Record<string, Occ[]> = {};
    (occs[one!.file] ??= []).push({ range: at(one!), symbol: sym("users") });
    (occs[two!.file] ??= []).push({ range: at(two!), symbol: sym("dependency") });
    (occs["routes/users.ts"] ??= []).push({ range: [13, 9, 13], symbol: sym("users"), def: true });
    await writeFile(join(dir, "index.scip"), index(Object.entries(occs).map(([f, o]) => [`sample-backend/${f}`, o])));
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, scip: join(dir, "index.scip") });
    expect(r).toMatchObject({ source: "scip", serversUsed: ["scip-typescript"], lspResolvedCount: 1, referenceLinksCount: 0 });
    const enh = JSON.parse(await readFile(join(dir, "an", "lsp-enhancement.json"), "utf-8"));
    const added = enh.symbolLinks.filter((l: { resolvedBy?: string }) => l.resolvedBy === "lsp");
    expect(added).toEqual([expect.objectContaining({ sourceFile: one!.file, sourceLine: one!.line, targetFile: "routes/users.ts", targetLine: 14 })]);
    expect(existsSync(join(dir, "an", "lsp-ground-truth.json"))).toBe(false);
  });
});
