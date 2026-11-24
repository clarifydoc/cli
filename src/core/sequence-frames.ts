import { join } from "path";
import { readFile } from "fs/promises";
import type { Cfg } from "../types/control-flow.js";
import { controlFlowForFile } from "./control-flow-file.js";

/**
 * The loops and branches a sequence diagram wraps its messages in, read off
 * each function's control-flow graph: a `LOOP` node is a `loop` frame over its
 * construct's lines; a `DECISION` is an `alt` whose `else` starts where its
 * false edge lands inside the construct, or an `opt` when there is no else; a
 * `CATCH` clause is a `break` frame — the path taken when the try fails —
 * unless the graph states its `try` statement (`Cfg.regions`): that is a
 * `critical` frame whose `catch` and `finally` clauses are `option` sections.
 * Where the graph knows columns, a frame starts and ends at them, so a
 * one-line `if (a) { x(); } else { y(); }` still splits into its arms.
 * On demand, like the sequence itself.
 */
export interface SequenceFrame {
  kind: "loop" | "alt" | "opt" | "break" | "critical";
  /** The construct as written (`for (const item of order.items)`). */
  label: string;
  line: number;
  endLine: number;
  /** 0-based column the construct starts at on `line` / ends at on `endLine`, when the graph states them. */
  column?: number;
  endColumn?: number;
  /** Where an `alt`'s else arm begins. */
  elseLine?: number;
  elseColumn?: number;
  /** A `critical` frame's sections (`option catch e`, `option finally`), in source order. */
  options?: Array<{ label: string; line: number; column?: number }>;
}

const POS = 100000;
const at = (line: number, column = 0): number => line * POS + column;

export function framesOfCfg(cfg: Cfg): SequenceFrame[] {
  const byId = new Map(cfg.nodes.map((n) => [n.id, n]));
  const frames: SequenceFrame[] = [];
  for (const region of cfg.regions ?? []) {
    frames.push({
      kind: "critical",
      label: "try",
      line: region.line,
      column: region.column,
      endLine: region.endLine,
      endColumn: region.endColumn,
      options: region.arms.map((a) => ({ label: a.label, line: a.line, column: a.column })),
    });
  }
  for (const n of cfg.nodes) {
    const oneLine = n.endLine <= n.line && !(n.column !== undefined && n.endColumn !== undefined && n.endColumn > n.column);
    if (oneLine && n.kind !== "LOOP" && n.kind !== "CATCH") continue;
    if (n.kind === "CATCH" && cfg.regions?.length) continue;
    if (n.kind === "LOOP" || n.kind === "CATCH") {
      frames.push({ kind: n.kind === "LOOP" ? "loop" : "break", label: n.label, line: n.line, endLine: Math.max(n.endLine, n.line), ...(n.column !== undefined ? { column: n.column, endColumn: n.endColumn } : {}) });
      continue;
    }
    if (n.kind !== "DECISION") continue;
    const out = cfg.edges.filter((e) => e.from === n.id && !e.back);
    // A switch's many arms read as one optional block; an if/else as two.
    const otherwise = out.length === 2 ? out.find((e) => e.label === "false" || e.label === "else") : undefined;
    const target = otherwise ? byId.get(otherwise.to) : undefined;
    const cols = n.column !== undefined && n.endColumn !== undefined && target?.column !== undefined;
    const inside = !!target && target.kind !== "MERGE" && target.kind !== "EXIT" && (cols ? at(target.line, target.column) > at(n.line, n.column) && at(target.line, target.column) < at(n.endLine, n.endColumn) : target.line > n.line && target.line <= n.endLine);
    const span = n.column !== undefined ? { column: n.column, endColumn: n.endColumn } : {};
    frames.push(inside ? { kind: "alt", label: n.label, line: n.line, endLine: n.endLine, ...span, elseLine: target!.line, ...(cols ? { elseColumn: target!.column } : {}) } : { kind: "opt", label: n.label, line: n.line, endLine: n.endLine, ...span });
  }
  return frames.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0) || b.endLine - a.endLine);
}

/** A frame's span as comparable positions (`line * 100000 + column`; a frame without columns covers whole lines). */
export function frameSpan(f: SequenceFrame, columns = true): { start: number; end: number } {
  return { start: at(f.line, columns ? (f.column ?? 0) : 0), end: at(f.endLine, columns ? (f.endColumn ?? POS - 1) : POS - 1) };
}

/** The sections inside a frame, each from its position on: an `alt`'s `else`, a `critical`'s `option`s. */
export function frameArms(f: SequenceFrame, columns = true): Array<{ start: number; text: string }> {
  if (f.options) return f.options.map((o) => ({ start: at(o.line, columns ? (o.column ?? 0) : 0), text: `option ${o.label}` }));
  return f.kind === "alt" && f.elseLine ? [{ start: at(f.elseLine, columns ? (f.elseColumn ?? 0) : 0), text: "else" }] : [];
}

/**
 * Frames for every function of `files` (project-relative), per file: a
 * frame wraps only the calls on its own lines, so one list serves every
 * function there — an inline route handler with no name of its own included.
 * A file with no control-flow support, or that no longer parses, gives none.
 */
export async function sequenceFrames(projectRoot: string, files: Iterable<string>): Promise<Map<string, SequenceFrame[]>> {
  return (await sequenceReading(projectRoot, files)).frames;
}

/** A file's text and the span of each of its functions: what the order of calls inside one function is read from. */
export interface FileSource {
  lines: string[];
  functions: Map<string, { line: number; endLine: number }>;
}

/** `sequenceFrames`, with each file's source and function spans (`SequenceOptions.sources`) read in the same pass. */
export async function sequenceReading(projectRoot: string, files: Iterable<string>): Promise<{ frames: Map<string, SequenceFrame[]>; sources: Map<string, FileSource> }> {
  const frames = new Map<string, SequenceFrame[]>();
  const sources = new Map<string, FileSource>();
  for (const file of new Set(files)) {
    try {
      const result = await controlFlowForFile({ filePath: join(projectRoot, file), displayPath: file });
      const own = result.cfgs.flatMap(framesOfCfg).sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0) || b.endLine - a.endLine);
      if (own.length) frames.set(file, own);
      const text = await readFile(join(projectRoot, file), "utf8");
      sources.set(file, { lines: text.split(/\r?\n/), functions: new Map(result.available.map((f) => [f.functionName, { line: f.line, endLine: f.endLine }])) });
    } catch {
      // No graph for this file: its messages are drawn unframed.
    }
  }
  return { frames, sources };
}
