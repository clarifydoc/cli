import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { updateLsp } from "../core/lsp-updater.js";
import { decodeScip, mergeScip, scipAnswers, scipPathMapper } from "./scip.js";
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
  /** Raw symbol_roles bits, when more than the Definition bit matters. */
  roles?: number;
  /** The typed_range oneof: SingleLineRange (field 8) or MultiLineRange (field 9). */
  typed?: number[];
}
// An empty `range` writes no field 1 at all, as a producer that sets only the typed range does.
const occurrence = (o: Occ) => [
  ...(o.range.length ? bytes(1, o.range.flatMap(varint)) : []),
  ...str(2, o.symbol),
  ...(o.roles ? int(3, o.roles) : o.def ? int(3, 1) : []),
  ...(o.typed ? bytes(o.typed.length === 3 ? 8 : 9, o.typed.flatMap((n, i) => int(i + 1, n))) : []),
];
/** Document.position_encoding (6) and Document.text (5), set per path. */
const docExtras = new Map<string, { enc?: number; text?: string }>();
const doc = (path: string, occs: Occ[]) => {
  const x = docExtras.get(path);
  return [...str(1, path), ...occs.flatMap((o) => bytes(2, occurrence(o))), ...(x?.text !== undefined ? str(5, x.text) : []), ...(x?.enc ? int(6, x.enc) : [])];
};
const index = (docs: Array<[string, Occ[]]>, root = "file:///repo", tool = "scip-typescript") =>
  new Uint8Array([
    ...bytes(1, [...bytes(2, str(1, tool)), ...str(3, root)]),
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

  it("reads the typed range, which wins over the deprecated one when both are set", () => {
    const decoded = decodeScip(index([["src/a.ts", [
      { range: [], typed: [3, 4, 9], symbol: "a#" },
      { range: [], typed: [0, 9, 1, 2], symbol: "b#" },
      { range: [7, 0, 1], typed: [3, 4, 9], symbol: "c#" },
    ]]]));
    expect(decoded.documents[0]!.occurrences.map((o) => o.range)).toEqual([[3, 4, 9], [0, 9, 1, 2], [3, 4, 9]]);
  });

  it("refuses a truncated index rather than guessing", () => {
    const whole = index([["src/a.ts", [{ range: [1, 2, 3], symbol: "x" }]]]);
    expect(() => decodeScip(whole.subarray(0, whole.length - 12))).toThrow();
  });
});

describe("mergeScip", () => {
  const files = new Set(["web/src/a.ts", "api/club.py", "api/b.py"]);
  it("joins the indexes of a polyglot repository, each mapped from its own root", () => {
    const ts = decodeScip(index([["src/a.ts", []]], "file:///repo/web"));
    const py = decodeScip(index([["api/club.py", []], ["api/b.py", []]], "file:///repo", "scip-python"));
    const merged = mergeScip([ts, py], files);
    expect(merged.tools).toEqual(["scip-typescript", "scip-python"]);
    expect(merged.documents.map((d) => d.path)).toEqual(["web/src/a.ts", "api/club.py", "api/b.py"]);
  });

  it("keeps `local N` per document when two indexers cover one file", () => {
    const a = decodeScip(index([["src/a.ts", [{ range: [5, 0, 3], symbol: "local 0" }, { range: [1, 0, 3], symbol: "local 0", def: true }]]]));
    const b = decodeScip(index([["src/a.ts", [{ range: [8, 0, 3], symbol: "local 0" }, { range: [2, 0, 3], symbol: "local 0", def: true }]]], "file:///repo", "scip-other"));
    const out = scipAnswers(mergeScip([a, b]), [
      { file: "src/a.ts", line: 6, column: 1, callName: "x", language: "typescript" },
      { file: "src/a.ts", line: 9, column: 1, callName: "x", language: "typescript" },
    ]);
    expect(out.servers).toEqual(["scip-typescript", "scip-other"]);
    expect(out.answers.map((x) => x.targets)).toEqual([[{ file: "src/a.ts", line: 2 }], [{ file: "src/a.ts", line: 3 }]]);
  });

  it("answers across indexes: a call in one language's index to a definition in another's", () => {
    const SHARED = "scip-x npm app 1.0 shared/Club#";
    const a = decodeScip(index([["src/a.ts", [{ range: [0, 0, 4], symbol: SHARED }]]]));
    const b = decodeScip(index([["src/b.ts", [{ range: [6, 0, 4], symbol: SHARED, def: true }]]], "file:///repo", "scip-other"));
    expect(scipAnswers(mergeScip([a, b]), [{ file: "src/a.ts", line: 1, column: 1, callName: "Club", language: "typescript" }]).answers[0]!.targets).toEqual([{ file: "src/b.ts", line: 7 }]);
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

  it("answers from an index that writes only typed ranges", () => {
    const idx = decodeScip(index([
      ["src/a.ts", [{ range: [], typed: [4, 2, 5], symbol: RUN }]],
      ["src/b.ts", [{ range: [], typed: [9, 16, 19], symbol: RUN, def: true }]],
    ]));
    expect(scipAnswers(idx, [q("src/a.ts", 5, 3)]).answers).toEqual([{ file: "src/a.ts", line: 5, column: 3, targets: [{ file: "src/b.ts", line: 10 }] }]);
  });

  describe("position encoding", () => {
    // `const club = "⚽⚽"; run()` — two football emoji (2 UTF-16 units, 4 UTF-8 bytes, 1 code point each) before the call.
    const line = 'const club = "\u26bd\u{1f3c6}"; run()';
    const utf16At = line.indexOf("run");
    const bytesAt = Buffer.byteLength(line.slice(0, utf16At), "utf8");
    const pointsAt = [...line.slice(0, utf16At)].length;
    const run = (enc: number | undefined, col: number, text?: string) => {
      docExtras.clear();
      docExtras.set("src/a.ts", { enc, ...(text !== undefined ? { text } : {}) });
      const idx = decodeScip(index([
        ["src/a.ts", [{ range: [0, col, col + 3], symbol: RUN }]],
        ["src/b.ts", [{ range: [9, 16, 19], symbol: RUN, def: true }]],
      ]));
      docExtras.clear();
      return idx;
    };
    const hit = [{ file: "src/a.ts", line: 1, column: utf16At, targets: [{ file: "src/b.ts", line: 10 }] }];

    it("reads the document's declared encoding", () => {
      expect(run(1, 0).documents[0]!.positionEncoding).toBe("utf8");
      expect(run(3, 0).documents[0]!.positionEncoding).toBe("utf32");
      expect(run(undefined, 0).documents[0]!.positionEncoding).toBeUndefined();
    });

    it("converts UTF-8 byte offsets to the query's UTF-16 columns, from the document's text or the file", () => {
      expect(bytesAt).not.toBe(utf16At);
      expect(scipAnswers(run(1, bytesAt, line), [q("src/a.ts", 1, utf16At)]).answers).toEqual(hit);
      expect(scipAnswers(run(1, bytesAt), [q("src/a.ts", 1, utf16At)], undefined, (p, l) => (p === "src/a.ts" && l === 0 ? line : undefined)).answers).toEqual(hit);
      // The byte offset taken as UTF-16 would miss.
      expect(scipAnswers(run(undefined, bytesAt), [q("src/a.ts", 1, utf16At)]).answers).toEqual([]);
    });

    it("converts UTF-32 offsets (code points)", () => {
      expect(pointsAt).not.toBe(utf16At);
      expect(scipAnswers(run(3, pointsAt, line), [q("src/a.ts", 1, utf16At)]).answers).toEqual(hit);
    });

    it("leaves UTF-16 and unspecified documents as they are", () => {
      expect(scipAnswers(run(2, utf16At), [q("src/a.ts", 1, utf16At)]).answers).toEqual(hit);
      expect(scipAnswers(run(undefined, utf16At), [q("src/a.ts", 1, utf16At)]).answers).toEqual(hit);
    });
  });

  describe("roles", () => {
    const CLUB = "scip-typescript npm app 1.0 src/`b.ts`/Club#";
    const answer = (docs: Array<[string, Occ[]]>, refRoles = 0) =>
      scipAnswers(decodeScip(index([["src/a.ts", [{ range: [], typed: [0, 0, 4], symbol: CLUB, roles: refRoles }]], ...docs])), [q("src/a.ts", 1, 1)]).answers[0]!.targets;

    it("keeps test and generated definitions out of a production reference's answer", () => {
      expect(answer([["src/b.ts", [{ range: [2, 0, 4], symbol: CLUB, def: true }]], ["test/b.test.ts", [{ range: [5, 0, 4], symbol: CLUB, roles: 0x21 }]], ["gen/b.ts", [{ range: [7, 0, 4], symbol: CLUB, roles: 0x11 }]]]))
        .toEqual([{ file: "src/b.ts", line: 3 }]);
      // Nothing else defines it: no answer, rather than a test file's.
      expect(answer([["test/b.test.ts", [{ range: [5, 0, 4], symbol: CLUB, roles: 0x21 }]]])).toEqual([]);
    });

    it("lets a test reference land in test code", () => {
      expect(answer([["test/b.test.ts", [{ range: [5, 0, 4], symbol: CLUB, roles: 0x21 }]]], 0x20)).toEqual([{ file: "test/b.test.ts", line: 6 }]);
    });

    it("prefers a definition to a forward declaration, and keeps a lone forward declaration", () => {
      expect(answer([["inc/club.h", [{ range: [1, 0, 4], symbol: CLUB, roles: 0x40 }]], ["src/club.c", [{ range: [9, 0, 4], symbol: CLUB, def: true }]]])).toEqual([{ file: "src/club.c", line: 10 }]);
      expect(answer([["inc/club.h", [{ range: [1, 0, 4], symbol: CLUB, roles: 0x40 }]]])).toEqual([{ file: "inc/club.h", line: 2 }]);
    });
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
    (occs[one!.file] ??= []).push({ range: at(one!), symbol: sym("players") });
    (occs[two!.file] ??= []).push({ range: at(two!), symbol: sym("dependency") });
    (occs["routes/players.ts"] ??= []).push({ range: [13, 9, 13], symbol: sym("players"), def: true });
    await writeFile(join(dir, "index.scip"), index(Object.entries(occs).map(([f, o]) => [`sample-backend/${f}`, o])));
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, scip: join(dir, "index.scip") });
    expect(r).toMatchObject({ source: "scip", serversUsed: ["scip-typescript"], lspResolvedCount: 1, referenceLinksCount: 0 });
    const enh = JSON.parse(await readFile(join(dir, "an", "lsp-enhancement.json"), "utf-8"));
    const added = enh.symbolLinks.filter((l: { resolvedBy?: string }) => l.resolvedBy === "lsp");
    expect(added).toEqual([expect.objectContaining({ sourceFile: one!.file, sourceLine: one!.line, targetFile: "routes/players.ts", targetLine: 14 })]);
    expect(existsSync(join(dir, "an", "lsp-ground-truth.json"))).toBe(false);
  });

  it("takes several indexes, one per indexer", async () => {
    const [one] = queries;
    const sym = "scip-typescript npm sample 1.0 players";
    await writeFile(join(dir, "calls.scip"), index([[`sample-backend/${one!.file}`, [{ range: [one!.line - 1, one!.column, one!.column + 1], symbol: sym }]]]));
    await writeFile(join(dir, "defs.scip"), index([["routes/players.ts", [{ range: [13, 9, 13], symbol: sym, def: true }]]], "file:///repo", "scip-other"));
    const r = await updateLsp({ analysisDir: join(dir, "an"), projectRoot: fixture, scip: [join(dir, "calls.scip"), join(dir, "defs.scip")] });
    expect(r).toMatchObject({ source: "scip", serversUsed: ["scip-typescript", "scip-other"], lspResolvedCount: 1 });
  });
});
