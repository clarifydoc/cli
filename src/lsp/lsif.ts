import type { DefinitionAnswerFile } from "./answers-source.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";
import { scipPathMapper } from "./scip.js";

/**
 * An LSIF dump (`dump.lsif`, what older CI pipelines and lsif-* indexers
 * write) as layer-2 answers, the way `scip.ts` reads a SCIP index. LSIF is a
 * graph, one vertex or edge per JSON line (or one JSON array):
 *
 *   document ──contains──▶ range ──next──▶ resultSet ──textDocument/definition──▶ definitionResult ──item──▶ range(s)
 *
 * The range at a question's position follows `next` to the vertex that has a
 * definition result; that result's item ranges are the targets. Paths are the
 * documents' URIs relative to `metaData.projectRoot`, mapped onto the
 * analysis by `scipPathMapper` when the dump was built at another root.
 * `metaData.positionEncoding` (`utf-8` / `utf-16` / `utf-32`, default
 * UTF-16) is converted to the queries' UTF-16 columns from the project file
 * the same way SCIP converts a document's encoding. `lspStats.source` is `lsif`.
 */

interface Position { line: number; character: number }
interface Range { start: Position; end: Position; doc?: string }

/** What `metaData.positionEncoding` counts; unset / `utf-16` leaves offsets as written. */
export type LsifPositionEncoding = "utf8" | "utf16" | "utf32";

export interface LsifDump {
  tool?: string;
  /** From `metaData.positionEncoding`; unset means UTF-16 (the LSIF default). */
  positionEncoding?: LsifPositionEncoding;
  /** Document path (relative to the dump's project root) → its ranges. */
  documents: Map<string, Range[]>;
  /** Range → the definition ranges its symbol resolves to. */
  definitionsOf(range: Range): Range[];
  /** Document id → path, for the definitions' files. */
  pathOf(docId: string): string | undefined;
}

type Element = { id: number | string; type: "vertex" | "edge"; label: string; [k: string]: unknown };

function elements(text: string): Element[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as Element[];
  const out: Element[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as Element);
    } catch {
      // A torn last line in a dump cut short: the rest still answers.
    }
  }
  return out;
}

const key = (id: unknown) => String(id);

function parseEncoding(raw: unknown): LsifPositionEncoding | undefined {
  if (raw === "utf-8" || raw === "utf8") return "utf8";
  if (raw === "utf-16" || raw === "utf16") return "utf16";
  if (raw === "utf-32" || raw === "utf32") return "utf32";
  return undefined;
}

/**
 * A dump's character offset on one line as UTF-16 code units. UTF-8 and
 * UTF-32 offsets differ from them only past a non-ASCII character, and the
 * line's text says where; without it the offset stands as written, which is
 * right for an ASCII line.
 */
function toUtf16(enc: LsifPositionEncoding | undefined, offset: number, text: string | undefined): number {
  if (!enc || enc === "utf16" || offset === 0) return offset;
  if (text === undefined) return offset;
  let units = 0;
  let counted = 0;
  for (const ch of text) {
    if (counted >= offset) break;
    counted += enc === "utf32" ? 1 : Buffer.byteLength(ch, "utf8");
    units += ch.length;
  }
  return units + Math.max(0, offset - counted);
}

export function decodeLsif(text: string): LsifDump {
  let root = "";
  let tool: string | undefined;
  let positionEncoding: LsifPositionEncoding | undefined;
  const docPath = new Map<string, string>();
  const ranges = new Map<string, Range>();
  const next = new Map<string, string>();
  const definitionOf = new Map<string, string>();
  const items = new Map<string, string[]>();
  const contains: Array<{ doc: string; ranges: string[] }> = [];
  for (const e of elements(text)) {
    if (e.type === "vertex") {
      if (e.label === "metaData") {
        root = String(e.projectRoot ?? "");
        tool = (e.toolInfo as { name?: string } | undefined)?.name;
        positionEncoding = parseEncoding(e.positionEncoding);
      } else if (e.label === "document") docPath.set(key(e.id), String(e.uri ?? ""));
      else if (e.label === "range") ranges.set(key(e.id), { start: e.start as Position, end: e.end as Position });
      continue;
    }
    const inVs = (Array.isArray(e.inVs) ? e.inVs : e.inV !== undefined ? [e.inV] : []).map(key);
    if (e.label === "contains") contains.push({ doc: key(e.outV), ranges: inVs });
    else if (e.label === "next") next.set(key(e.outV), inVs[0]!);
    else if (e.label === "textDocument/definition") definitionOf.set(key(e.outV), inVs[0]!);
    else if (e.label === "item") items.set(key(e.outV), [...(items.get(key(e.outV)) ?? []), ...inVs]);
  }
  const rootUri = root.replace(/\/+$/, "") + "/";
  const relative = (uri: string) => decodeURIComponent(uri.startsWith(rootUri) ? uri.slice(rootUri.length) : uri.replace(/^file:\/\//, ""));
  const documents = new Map<string, Range[]>();
  for (const c of contains) {
    const uri = docPath.get(c.doc);
    if (!uri) continue;
    const list = documents.get(relative(uri)) ?? [];
    for (const id of c.ranges) {
      const r = ranges.get(id);
      if (!r) continue;
      r.doc = c.doc;
      list.push(r);
    }
    documents.set(relative(uri), list);
  }
  const idOf = new Map<Range, string>();
  for (const [id, r] of ranges) idOf.set(r, id);
  return {
    tool,
    positionEncoding,
    documents,
    definitionsOf(range: Range): Range[] {
      let at: string | undefined = idOf.get(range);
      for (let hops = 0; at && hops < 16; hops++) {
        const result = definitionOf.get(at);
        if (result) return (items.get(result) ?? []).map((id) => ranges.get(id)).filter((r): r is Range => !!r);
        at = next.get(at);
      }
      return [];
    },
    pathOf: (docId: string) => {
      const uri = docPath.get(docId);
      return uri ? relative(uri) : undefined;
    },
  };
}

/** Answers to the layer-2 questions from an LSIF dump; a definition outside the analysis is not a target. */
export function lsifAnswers(
  dump: LsifDump,
  queries: readonly DefinitionQuery[],
  analysisFiles: ReadonlySet<string>,
  lineText?: (path: string, line0: number) => string | undefined,
): DefinitionAnswerFile {
  const map = scipPathMapper([...dump.documents.keys()].map((path) => ({ path, occurrences: [] })), analysisFiles);
  const byPath = new Map<string, Range[]>();
  for (const [path, list] of dump.documents) {
    const mapped = map(path);
    if (mapped) byPath.set(mapped, list);
  }
  const answers: DefinitionAnswerFile["answers"] = [];
  for (const q of queries) {
    const list = byPath.get(q.file);
    if (!list) continue;
    const line0 = q.line - 1;
    // Queries count UTF-16 code units; the dump counts what metaData.positionEncoding says.
    const col = (line: number, c: number) => toUtf16(dump.positionEncoding, c, lineText?.(q.file, line));
    const inside = (r: Range) =>
      (line0 > r.start.line || (line0 === r.start.line && q.column >= col(r.start.line, r.start.character))) &&
      (line0 < r.end.line || (line0 === r.end.line && q.column < col(r.end.line, r.end.character)));
    // The innermost range at the position.
    const at = list.filter(inside).sort((a, b) => (a.end.line - a.start.line) - (b.end.line - b.start.line) || (a.end.character - a.start.character) - (b.end.character - b.start.character))[0];
    if (!at) continue;
    const targets: Array<{ file: string; line: number }> = [];
    for (const d of dump.definitionsOf(at)) {
      const path = d.doc ? dump.pathOf(d.doc) : undefined;
      const file = path ? map(path) : null;
      if (file && analysisFiles.has(file)) targets.push({ file, line: d.start.line + 1 });
    }
    answers.push({ file: q.file, line: q.line, column: q.column, targets });
  }
  return { source: "lsif", servers: [dump.tool ?? "lsif"], answers };
}
