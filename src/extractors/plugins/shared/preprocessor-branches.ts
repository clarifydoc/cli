/**
 * The C preprocessor's conditionals for the C-family parser front ends, which read a file without running it: code
 * no compiler sees (`#if 0`) is blanked, and a file whose `#if`/`#else` branches together are no valid program (a
 * function header written once per platform before one body) is read again with one branch of each. Lines and
 * columns are kept: a blanked line is spaces.
 */
import type { ParsedStructure } from "../../../types/language-plugin.js";
import type { ConditionalBlock } from "./regex-base.js";

/** The directive a line holds, its continuation lines (`\` at the end) joined. */
const DIRECTIVE = /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/;

/** A conditional the text is in: which of its `count` branches, and whether its first is `dead`. */
export interface Frame {
  branch: number;
  count: number;
  dead: boolean;
}

/**
 * A condition no compiler of the language takes: `#if 0`, and `__cplusplus` defined or not as the language is C or
 * C++ (`#ifdef __cplusplus` in C, `#ifndef __cplusplus` in C++).
 */
function deadCondition(kind: string, rest: string, cplusplus: boolean): boolean {
  const cond = rest.trim();
  if (kind === "if" && (cond === "0" || /^\(\s*0\s*\)$/.test(cond))) return true;
  const plusplus = (kind === "if" && (/^defined\s*\(?\s*__cplusplus\s*\)?$/.test(cond) || cond === "__cplusplus")) || (kind === "ifdef" && cond === "__cplusplus");
  const notPlusplus = (kind === "if" && /^!\s*defined\s*\(?\s*__cplusplus\s*\)?$/.test(cond)) || (kind === "ifndef" && cond === "__cplusplus");
  return cplusplus ? notPlusplus : plusplus;
}

/**
 * The text with conditional branches blanked out, lines and columns kept. A frame's first branch is `dead` when no
 * compiler takes it; `keep(frame)` says whether the branch a line is in stays.
 */
function blankBranches(text: string, cplusplus: boolean, keep: (frame: Frame) => boolean): string {
  const lines = text.split("\n");
  // How many branches each conditional has, in the order they open.
  const counts: number[] = [];
  const open: number[] = [];
  for (const line of lines) {
    const kind = DIRECTIVE.exec(line)?.[1];
    if (kind === "if" || kind === "ifdef" || kind === "ifndef") open.push(counts.push(1) - 1);
    else if (kind === "endif") open.pop();
    else if (kind && open.length > 0) counts[open.at(-1)!]!++;
  }
  const frames: Frame[] = [];
  let opened = 0;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]!);
    if (m) {
      const kind = m[1]!;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") frames.push({ branch: 0, count: counts[opened++]!, dead: deadCondition(kind, m[2]!, cplusplus) });
      else if (kind === "endif") frames.pop();
      else if (frames.length > 0) frames.at(-1)!.branch++;
      while (lines[i]!.endsWith("\\") && i + 1 < lines.length) i++;
      continue;
    }
    if (frames.length > 0 && !frames.every(keep)) {
      lines[i] = lines[i]!.replace(/\S/g, " ");
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}

/** Dead blocks (`#if 0`) blanked, their `#else` kept. */
function withoutDeadCode(text: string, cplusplus: boolean): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => !(f.dead && f.branch === 0));
}

/** Only the first branch of every conditional kept (the live one after a dead `#if 0`). */
function firstBranches(text: string, cplusplus: boolean): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => f.branch === (f.dead ? 1 : 0));
}

/** Only the second branch of every conditional kept, or its only one: what an `#else` defines for another platform. */
function secondBranches(text: string, cplusplus: boolean): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => f.branch === (f.dead ? 1 : Math.min(1, f.count - 1)));
}

/**
 * Every conditional of the file as a block: its `#if` and `#endif` lines and the live arms between its directives
 * (0-based, inclusive; an arm may be empty). An arm no compiler takes is left out — `#if 0`, and with `cplusplus`
 * set, the `__cplusplus` arm the language never sees; `cplusplus` undefined (Objective-C, which is either) judges
 * only `#if 0`. A block an unbalanced file leaves open is dropped.
 */
export function conditionalBlocks(lines: readonly string[], cplusplus?: boolean): ConditionalBlock[] {
  const out: ConditionalBlock[] = [];
  const open: Array<{ start: number; armStart: number; branch: number; dead: boolean; arms: Array<readonly [number, number]> }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("#")) continue;
    const m = DIRECTIVE.exec(lines[i]!);
    if (!m) continue;
    const kind = m[1]!;
    const at = i;
    while (lines[i]!.endsWith("\\") && i + 1 < lines.length) i++;
    if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
      const dead = cplusplus === undefined ? deadCondition(kind, m[2]!, false) && !m[2]!.includes("__cplusplus") : deadCondition(kind, m[2]!, cplusplus);
      open.push({ start: at, armStart: i + 1, branch: 0, dead, arms: [] });
      continue;
    }
    const frame = open.at(-1);
    if (!frame) continue;
    // The arm this directive closes; only the first can be one no compiler takes (an `#elif` after `#if 0` is live).
    if (!(frame.dead && frame.branch === 0)) frame.arms.push([frame.armStart, at - 1]);
    frame.branch++;
    frame.armStart = i + 1;
    if (kind === "endif") {
      open.pop();
      out.push({ start: frame.start, end: at, arms: frame.arms });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** The lines of `compiled` that `read` blanked, the rest blank: the branches a reading of `read` leaves out. */
function leftOut(compiled: string, read: string): string {
  const kept = read.split("\n");
  return compiled
    .split("\n")
    .map((line, i) => (kept[i]!.trim() === "" && line.trim() !== "" ? line : ""))
    .join("\n");
}

/** Whether the braces of the code in `text` (comments, strings and directive lines left out) pair up. */
function bracesPair(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, "");
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * One function's text as `readWithBranches` reads a file, for a reader that cannot tell by parsing: without dead
 * blocks (`#if 0`) and, when the branches together leave the braces unpaired (a header written once per platform
 * before one body), with only the first branch of every conditional. Lines are kept.
 */
export function compilerView(text: string, cplusplus: boolean): string {
  if (!text.includes("#")) return text;
  const compiled = withoutDeadCode(text, cplusplus);
  return bracesPair(compiled) ? compiled : firstBranches(compiled, cplusplus);
}

/** A front end's reading of a text; `also` is code the reading leaves out, lines in place, whose calls it counts. */
type Read = (text: string, also?: string) => ParsedStructure;

/**
 * A C-family file read as a compiler of the language would see it: without dead blocks, and, when that does not
 * parse, with only the first branch of every conditional (the other branches' calls counted where they fall), plus
 * the functions a second-branch reading defines where the first branches left nothing — another platform's `#else`.
 */
export function readWithBranches(text: string, cplusplus: boolean, read: Read): ParsedStructure {
  const compiled = withoutDeadCode(text, cplusplus);
  const first = read(compiled);
  if (first.syntaxErrors === 0) return first;
  const branches = firstBranches(compiled, cplusplus);
  if (branches === compiled) return first;
  const second = read(branches, leftOut(compiled, branches));
  if (second.syntaxErrors > 0) return first;
  const others = secondBranches(compiled, cplusplus);
  if (others === branches) return second;
  const third = read(others);
  if (third.syntaxErrors > 0) return second;
  // A definition the first branches left out, and no function of theirs spans: not the same function's other header.
  const left = branches.split("\n");
  const added = third.functions.filter(
    (fn) => left[fn.line - 1]!.trim() === "" && !second.functions.some((kept) => kept.line <= fn.endLine && fn.line <= kept.endLine),
  );
  if (added.length === 0) return second;
  return { ...second, functions: [...second.functions, ...added].sort((a, b) => a.line - b.line) };
}
