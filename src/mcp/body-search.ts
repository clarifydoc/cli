/**
 * Full-text search over function bodies, for `clarifydoc_search body=true`.
 *
 * Name search finds what is called a thing; this finds what DOES it — "where
 * do we hash passwords" when nothing is named `hash`. Each function (its span
 * from the analysis's complexity rows) is a document: its body plus the doc
 * comment right above it, read from the source. Terms are split as names are
 * (separators and camelCase, lowercased), common keywords dropped, and ranked
 * with BM25 (k1 = 1.2, b = 0.75). Deterministic: same source, same order.
 *
 * Built lazily on the first body query, once per analysis, in memory; files
 * over 1 MB and text past a total budget are left out (said in the result).
 */

import { splitTokens } from "./search-rank.js";

export interface BodyDoc {
  file: string;
  name: string;
  line: number;
  endLine: number;
  /** Term → count in this document. */
  terms: Map<string, number>;
  length: number;
  /** The document's lines, with their 1-based line numbers. */
  lines: Array<{ n: number; text: string }>;
}

export interface BodyHit {
  doc: BodyDoc;
  score: number;
  /** The line with the most query terms, trimmed. */
  best: { n: number; text: string };
}

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "if", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "function", "return", "const", "let", "var", "new", "this", "self", "def", "class", "public", "private", "protected", "static",
  "void", "async", "await", "else", "elif", "while", "do", "try", "catch", "finally", "import", "export", "default", "null", "nil",
  "none", "true", "false", "undefined", "end", "fn", "func", "pub", "val", "int", "string", "bool", "end",
]);

const K1 = 1.2;
const B = 0.75;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_CHARS = 40_000_000;

const termsOf = (text: string): string[] => splitTokens(text).filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));

export class BodyIndex {
  readonly docs: BodyDoc[] = [];
  private readonly df = new Map<string, number>();
  private avgLength = 0;
  /** Files left out (too large, unreadable, over budget). */
  skipped = 0;

  static async build(
    spans: ReadonlyArray<{ file: string; functions: ReadonlyArray<{ name: string; line: number; endLine: number }> }>,
    readText: (file: string) => Promise<string | null>,
  ): Promise<BodyIndex> {
    const index = new BodyIndex();
    let total = 0;
    for (const { file, functions } of spans) {
      if (functions.length === 0) continue;
      if (total > MAX_TOTAL_CHARS) {
        index.skipped++;
        continue;
      }
      const text = await readText(file);
      if (text === null || text.length > MAX_FILE_BYTES) {
        index.skipped++;
        continue;
      }
      total += text.length;
      const all = text.split(/\r?\n/);
      for (const fn of functions) {
        if (!fn.line || fn.endLine < fn.line) continue;
        // The doc comment right above: comment-looking lines, back to a blank or code line.
        let start = fn.line - 1;
        for (let k = fn.line - 2; k >= 0 && k >= fn.line - 16; k--) {
          const l = all[k]!.trim();
          if (/^(?:\/\/|\/\*|\*|#|--|"""|'''|\/\/\/)/.test(l) || l.endsWith("*/")) start = k;
          else break;
        }
        const lines = all.slice(start, fn.endLine).map((t, i) => ({ n: start + i + 1, text: t }));
        const terms = new Map<string, number>();
        for (const l of lines) for (const t of termsOf(l.text)) terms.set(t, (terms.get(t) ?? 0) + 1);
        // The function's own name counts as its words too.
        for (const t of termsOf(fn.name)) terms.set(t, (terms.get(t) ?? 0) + 1);
        const length = [...terms.values()].reduce((a, b) => a + b, 0);
        index.docs.push({ file, name: fn.name, line: fn.line, endLine: fn.endLine, terms, length, lines });
        for (const t of terms.keys()) index.df.set(t, (index.df.get(t) ?? 0) + 1);
      }
    }
    index.avgLength = index.docs.length ? index.docs.reduce((a, d) => a + d.length, 0) / index.docs.length : 0;
    return index;
  }

  search(query: string, limit: number, keep?: (doc: BodyDoc) => boolean): BodyHit[] {
    const q = [...new Set(termsOf(query))];
    if (q.length === 0 || this.docs.length === 0) return [];
    const n = this.docs.length;
    const idf = new Map(q.map((t) => [t, Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))]));
    const hits: BodyHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const t of q) {
        const f = doc.terms.get(t);
        if (!f) continue;
        score += idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1))));
      }
      if (score <= 0 || (keep && !keep(doc))) continue;
      let best = doc.lines[0]!;
      let bestCount = -1;
      for (const l of doc.lines) {
        const terms = new Set(termsOf(l.text));
        const count = q.filter((t) => terms.has(t)).length;
        if (count > bestCount) {
          best = l;
          bestCount = count;
        }
      }
      hits.push({ doc, score, best: { n: best.n, text: best.text.trim().slice(0, 140) } });
    }
    hits.sort((a, b) => b.score - a.score || (a.doc.file < b.doc.file ? -1 : a.doc.file > b.doc.file ? 1 : a.doc.line - b.doc.line));
    return hits.slice(0, limit);
  }
}

/** Error types a body throws or raises (`throw new NotFoundError(…)`, `raise ValueError`, `throw NotFound()`). */
export function thrownTypes(doc: BodyDoc): string[] {
  const out = new Set<string>();
  for (const l of doc.lines) {
    for (const m of l.text.matchAll(/\b(?:throw|raise)\s+(?:new\s+)?([A-Z][\w.]*)/g)) out.add(m[1]!.split(".").pop()!);
  }
  return [...out];
}
