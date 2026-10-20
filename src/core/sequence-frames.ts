import { join } from "path";
import type { Cfg } from "../types/control-flow.js";
import { controlFlowForFile } from "./control-flow-file.js";

/**
 * The loops and branches a sequence diagram wraps its messages in, read off
 * each function's control-flow graph: a `LOOP` node is a `loop` frame over its
 * construct's lines; a `DECISION` is an `alt` whose `else` starts where its
 * false edge lands inside the construct, or an `opt` when there is no else; a
 * `CATCH` clause is a `break` frame — the path taken when the try fails.
 * On demand, like the sequence itself.
 */
export interface SequenceFrame {
  kind: "loop" | "alt" | "opt" | "break";
  /** The construct as written (`for (const item of order.items)`). */
  label: string;
  line: number;
  endLine: number;
  /** Where an `alt`'s else arm begins. */
  elseLine?: number;
}

export function framesOfCfg(cfg: Cfg): SequenceFrame[] {
  const byId = new Map(cfg.nodes.map((n) => [n.id, n]));
  const frames: SequenceFrame[] = [];
  for (const n of cfg.nodes) {
    if (n.endLine <= n.line && n.kind !== "LOOP" && n.kind !== "CATCH") continue;
    if (n.kind === "LOOP" || n.kind === "CATCH") {
      frames.push({ kind: n.kind === "LOOP" ? "loop" : "break", label: n.label, line: n.line, endLine: Math.max(n.endLine, n.line) });
      continue;
    }
    if (n.kind !== "DECISION") continue;
    const out = cfg.edges.filter((e) => e.from === n.id && !e.back);
    // A switch's many arms read as one optional block; an if/else as two.
    const otherwise = out.length === 2 ? out.find((e) => e.label === "false" || e.label === "else") : undefined;
    const target = otherwise ? byId.get(otherwise.to) : undefined;
    const elseLine = target && target.kind !== "MERGE" && target.kind !== "EXIT" && target.line > n.line && target.line <= n.endLine ? target.line : undefined;
    frames.push(elseLine ? { kind: "alt", label: n.label, line: n.line, endLine: n.endLine, elseLine } : { kind: "opt", label: n.label, line: n.line, endLine: n.endLine });
  }
  return frames.sort((a, b) => a.line - b.line || b.endLine - a.endLine);
}

/**
 * Frames for every function of `files` (project-relative), per file: a
 * frame wraps only the calls on its own lines, so one list serves every
 * function there — an inline route handler with no name of its own included.
 * A file with no control-flow support, or that no longer parses, gives none.
 */
export async function sequenceFrames(projectRoot: string, files: Iterable<string>): Promise<Map<string, SequenceFrame[]>> {
  const out = new Map<string, SequenceFrame[]>();
  for (const file of new Set(files)) {
    try {
      const result = await controlFlowForFile({ filePath: join(projectRoot, file), displayPath: file });
      const frames = result.cfgs.flatMap(framesOfCfg).sort((a, b) => a.line - b.line || b.endLine - a.endLine);
      if (frames.length) out.set(file, frames);
    } catch {
      // No graph for this file: its messages are drawn unframed.
    }
  }
  return out;
}
