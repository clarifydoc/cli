import type { DefinitionAnswerFile } from "./answers-source.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";

/**
 * A SCIP index (`index.scip`, what scip-typescript, scip-java, scip-python,
 * rust-analyzer and others write in CI) as layer-2 answers: for each
 * question the layer-2 pass would put (`planDefinitionQueries`), the
 * occurrence at that position names a symbol, and the occurrence that
 * DEFINES that symbol is the answer. Replayed through
 * `answersDefinitionSource`, so the same rules hold: one distinct target or
 * an abstention, paths inside the project only.
 *
 * Only the fields this needs are decoded — no protobuf dependency:
 * Index.metadata(1) → Metadata.tool_info(2).name(1), .project_root(3);
 * Index.documents(2) → Document.relative_path(1), .occurrences(2) →
 * Occurrence.range(1, packed int32), .symbol(2), .symbol_roles(3).
 */

export interface ScipOccurrence {
  /** 0-based: [line, startChar, endChar] or [startLine, startChar, endLine, endChar]. */
  range: number[];
  symbol: string;
  roles: number;
}

export interface ScipDocument {
  path: string;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  /** Metadata.project_root: the `file://` URI document paths are relative to. */
  projectRoot?: string;
  /** Metadata.tool_info.name: the indexer (`scip-typescript`, …). */
  tool?: string;
  documents: ScipDocument[];
}

const DEFINITION = 0x1;

const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error("truncated varint");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
  }

  bytes(): Reader {
    const len = this.varint();
    const start = this.pos;
    if (start + len > this.end) throw new Error("truncated field");
    this.pos += len;
    const r = new Reader(this.buf, start + len);
    r.pos = start;
    return r;
  }

  string(): string {
    const r = this.bytes();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }

  /** Each field: its number and wire type, the reader positioned at its value. */
  *fields(): Generator<[number, number]> {
    while (this.pos < this.end) {
      const tag = this.varint();
      yield [Math.floor(tag / 8), tag & 7];
    }
  }
}

function occurrence(r: Reader): ScipOccurrence {
  const o: ScipOccurrence = { range: [], symbol: "", roles: 0 };
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) {
      const packed = r.bytes();
      while (packed.pos < packed.end) o.range.push(packed.varint());
    } else if (field === 1 && wire === 0) o.range.push(r.varint());
    else if (field === 2 && wire === 2) o.symbol = r.string();
    else if (field === 3 && wire === 0) o.roles = r.varint();
    else r.skip(wire);
  }
  return o;
}

function document(r: Reader): ScipDocument {
  const d: ScipDocument = { path: "", occurrences: [] };
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) d.path = r.string();
    else if (field === 2 && wire === 2) d.occurrences.push(occurrence(r.bytes()));
    else r.skip(wire);
  }
  return d;
}

function metadata(r: Reader, into: ScipIndex): void {
  for (const [field, wire] of r.fields()) {
    if (field === 2 && wire === 2) {
      const tool = r.bytes();
      for (const [f, w] of tool.fields()) {
        if (f === 1 && w === 2) into.tool = tool.string();
        else tool.skip(w);
      }
    } else if (field === 3 && wire === 2) into.projectRoot = r.string();
    else r.skip(wire);
  }
}

/** A SCIP index: its metadata and documents. */
export function decodeScip(buf: Uint8Array): ScipIndex {
  const index: ScipIndex = { documents: [] };
  const r = new Reader(buf);
  for (const [field, wire] of r.fields()) {
    if (field === 1 && wire === 2) metadata(r.bytes(), index);
    else if (field === 2 && wire === 2) index.documents.push(document(r.bytes()));
    else r.skip(wire);
  }
  return index;
}

/**
 * How an index path becomes an analysis path when the index was built at
 * another root: the prefix that, added to or stripped from the index's
 * paths, names the most analysis files. Identity when they already agree.
 */
export function scipPathMapper(docs: readonly ScipDocument[], analysisFiles: ReadonlySet<string>): (p: string) => string | null {
  const paths = docs.map((d) => normalize(d.path));
  const hits = (map: (p: string) => string | null) => paths.reduce((n, p) => (analysisFiles.has(map(p) ?? "") ? n + 1 : n), 0);
  let best: { map: (p: string) => string | null; n: number } = { map: (p) => p, n: hits((p) => p) };
  if (best.n === paths.length) return best.map;
  // Stripping a leading directory: the index was built above the analysis root.
  const strips = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/") + "/")));
  for (const pre of strips) {
    const map = (p: string) => (p.startsWith(pre) ? p.slice(pre.length) : null);
    const n = hits(map);
    if (n > best.n) best = { map, n };
  }
  // Adding one: the index was built below it.
  const adds = new Set([...analysisFiles].flatMap((f) => f.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/") + "/")));
  for (const pre of adds) {
    const map = (p: string) => pre + p;
    const n = hits(map);
    if (n > best.n) best = { map, n };
  }
  return best.map;
}

/**
 * Answers to the layer-2 questions from a SCIP index. Local symbols
 * (`local N`) resolve within their document; a definition outside the
 * analysis (a dependency's sources) is not a target.
 */
export function scipAnswers(index: ScipIndex, queries: readonly DefinitionQuery[], mapPath: (p: string) => string | null = normalize): DefinitionAnswerFile {
  const definitions = new Map<string, Array<{ file: string; line: number }>>();
  const byPath = new Map<string, ScipDocument>();
  for (const d of index.documents) {
    const path = mapPath(normalize(d.path));
    if (!path) continue;
    byPath.set(path, d);
    for (const o of d.occurrences) {
      if (!(o.roles & DEFINITION) || !o.symbol || o.range.length < 3) continue;
      const key = o.symbol.startsWith("local ") ? `${path}\u0000${o.symbol}` : o.symbol;
      (definitions.get(key) ?? definitions.set(key, []).get(key)!).push({ file: path, line: o.range[0]! + 1 });
    }
  }
  const answers: DefinitionAnswerFile["answers"] = [];
  for (const q of queries) {
    const doc = byPath.get(q.file);
    if (!doc) continue;
    const line0 = q.line - 1;
    const at = doc.occurrences.find((o) => {
      if (o.range.length < 3 || o.roles & DEFINITION) return false;
      const [sl, sc] = o.range as [number, number];
      const el = o.range.length === 3 ? sl : o.range[2]!;
      const ec = o.range.length === 3 ? o.range[2]! : o.range[3]!;
      return line0 >= sl && line0 <= el && (line0 > sl || q.column >= sc) && (line0 < el || q.column < ec);
    });
    if (!at) continue;
    const key = at.symbol.startsWith("local ") ? `${q.file}\u0000${at.symbol}` : at.symbol;
    answers.push({ file: q.file, line: q.line, column: q.column, targets: definitions.get(key) ?? [] });
  }
  return { source: "scip", servers: [index.tool ?? "scip"], answers };
}
