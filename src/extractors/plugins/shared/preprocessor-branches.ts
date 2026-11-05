/**
 * The C preprocessor's conditionals for the C-family parser front ends, which read a file without running it: code
 * no compiler sees (`#if 0`) is blanked, and a file whose `#if`/`#else` branches together are no valid program (a
 * function header written once per platform before one body) is read again with one branch of each. Lines and
 * columns are kept: a blanked line is spaces.
 */
import type { BuildMacros, ParsedStructure } from "../../../types/language-plugin.js";
import type { ConditionalBlock } from "./regex-base.js";

/** The directive a line holds, its continuation lines (`\` at the end) joined. */
const DIRECTIVE = /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/;

/** A conditional the text is in: which of its `count` branches, and which branches no compiler takes (`dead`). */
export interface Frame {
  branch: number;
  count: number;
  dead: readonly boolean[];
}

/** A macro's state: its value (`""` for one defined with none), or null when it is known undefined. Absent: unknown. */
type MacroState = Map<string, string | null>;

const DEFINE = /^\s*#\s*(define|undef)\s+([A-Za-z_]\w*)(?:\s+(.*))?/;

/** A condition's value in three-valued logic: undefined when a macro it reads is not known. */
function evaluate(cond: string, macros: MacroState): boolean | undefined {
  const tokens = cond.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/g, " ").match(/defined|&&|\|\||==|!=|<=|>=|[()!<>]|\d+|[A-Za-z_]\w*|\S/g) ?? [];
  let at = 0;
  let bad = false;
  const number = (v: string | null | undefined): number | undefined => (v === null ? 0 : v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
  const primary = (): number | undefined => {
    const t = tokens[at++];
    if (t === undefined) { bad = true; return undefined; }
    if (t === "(") {
      const v = or();
      if (tokens[at++] !== ")") bad = true;
      return v;
    }
    if (t === "!") {
      const v = primary();
      return v === undefined ? undefined : v === 0 ? 1 : 0;
    }
    if (t === "defined") {
      const paren = tokens[at] === "(";
      if (paren) at++;
      const name = tokens[at++];
      if (paren && tokens[at++] !== ")") bad = true;
      if (name === undefined || !/^[A-Za-z_]\w*$/.test(name)) { bad = true; return undefined; }
      return macros.has(name) ? (macros.get(name) === null ? 0 : 1) : undefined;
    }
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z_]\w*$/.test(t)) return macros.has(t) ? number(macros.get(t)) : undefined;
    bad = true;
    return undefined;
  };
  const compare = (): number | undefined => {
    let left = primary();
    while (tokens[at] && /^(==|!=|<=|>=|<|>)$/.test(tokens[at]!)) {
      const op = tokens[at++]!;
      const right = primary();
      if (left === undefined || right === undefined) left = undefined;
      else left = (op === "==" ? left === right : op === "!=" ? left !== right : op === "<" ? left < right : op === ">" ? left > right : op === "<=" ? left <= right : left >= right) ? 1 : 0;
    }
    return left;
  };
  const and = (): number | undefined => {
    let left = compare();
    while (tokens[at] === "&&") {
      at++;
      const right = compare();
      left = left === 0 || right === 0 ? 0 : left === undefined || right === undefined ? undefined : 1;
    }
    return left;
  };
  const or = (): number | undefined => {
    let left = and();
    while (tokens[at] === "||") {
      at++;
      const right = and();
      left = (left !== undefined && left !== 0) || (right !== undefined && right !== 0) ? 1 : left === undefined || right === undefined ? undefined : 0;
    }
    return left;
  };
  const v = or();
  return bad || at < tokens.length || v === undefined ? undefined : v !== 0;
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
 * Which branches of each conditional no compiler takes, in the order the conditionals open. A branch is dead when its
 * condition is false (`#if 0`, `__cplusplus` as the language says, a macro known to the build or the file) or an
 * earlier branch certainly runs. With `buildMacros` (a compilation database's `-D`/`-U`) the file's own `#define`/`#undef`
 * lines count too, where every conditional around them is known taken; one inside a conditional whose outcome is not
 * known leaves the macro unknown. Without `buildMacros` only the language's own dead conditions are judged.
 */
function deadBranches(lines: readonly string[], cplusplus: boolean, buildMacros: BuildMacros | undefined): boolean[][] {
  const macros: MacroState = new Map();
  for (const m of buildMacros ?? []) macros.set(m.name, m.undefined ? null : (m.value ?? "1"));
  const judge = buildMacros !== undefined;
  const condition = (kind: string, rest: string): boolean | undefined => {
    if (deadCondition(kind, rest, cplusplus)) return false;
    if (!judge) return undefined;
    const name = /^[A-Za-z_]\w*/.exec(rest.trim())?.[0];
    if (kind === "ifdef" || kind === "elifdef") return name && macros.has(name) ? macros.get(name) !== null : undefined;
    if (kind === "ifndef" || kind === "elifndef") return name && macros.has(name) ? macros.get(name) === null : undefined;
    return evaluate(rest, macros);
  };
  const out: boolean[][] = [];
  // Per open conditional: its row, whether every earlier branch is known false, whether one certainly ran, and
  // whether the branch the text is in is known taken / known dead.
  const stack: Array<{ row: boolean[]; allFalse: boolean; ran: boolean; certain: boolean; dead: boolean }> = [];
  const branch = (frame: (typeof stack)[number], cond: boolean | undefined, parent: { certain: boolean; dead: boolean }): void => {
    const dead = cond === false || frame.ran;
    frame.row.push(dead);
    frame.dead = parent.dead || dead;
    frame.certain = parent.certain && cond === true && frame.allFalse;
    if (cond === true && frame.allFalse) frame.ran = true;
    frame.allFalse = frame.allFalse && cond === false;
  };
  const top = { certain: true, dead: false };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("#")) continue;
    const m = DIRECTIVE.exec(line);
    if (m) {
      const kind = m[1]!;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
        const frame = { row: [] as boolean[], allFalse: true, ran: false, certain: false, dead: false };
        out.push(frame.row);
        stack.push(frame);
        branch(frame, condition(kind, m[2]!), stack.length > 1 ? stack.at(-2)! : top);
      } else if (kind === "endif") {
        stack.pop();
      } else if (stack.length > 0) {
        branch(stack.at(-1)!, kind === "else" ? true : condition(kind, m[2]!), stack.length > 1 ? stack.at(-2)! : top);
      }
      while (lines[i]!.endsWith("\\") && i + 1 < lines.length) i++;
      continue;
    }
    if (!judge) continue;
    const d = DEFINE.exec(line);
    if (!d) continue;
    const here = stack.at(-1) ?? top;
    if (here.dead) continue;
    if (!here.certain) macros.delete(d[2]!);
    else if (d[1] === "undef") macros.set(d[2]!, null);
    else macros.set(d[2]!, (d[3] ?? "").trim());
  }
  return out;
}

/**
 * The text with conditional branches blanked out, lines and columns kept. A frame's `dead` says which of its
 * branches no compiler takes; `keep(frame)` says whether the branch a line is in stays.
 */
function blankBranches(text: string, cplusplus: boolean, keep: (frame: Frame) => boolean, macros?: BuildMacros): string {
  const lines = text.split("\n");
  const rows = deadBranches(lines, cplusplus, macros);
  const frames: Frame[] = [];
  let opened = 0;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]!);
    if (m) {
      const kind = m[1]!;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
        const dead = rows[opened++]!;
        frames.push({ branch: 0, count: dead.length, dead });
      } else if (kind === "endif") frames.pop();
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

/** Dead blocks (`#if 0`, a branch the build's macros rule out) blanked, their live branches kept. */
function withoutDeadCode(text: string, cplusplus: boolean, macros?: BuildMacros): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => !f.dead[f.branch], macros);
}

/** The branch a conditional reads as its first: the first no compiler rules out. */
const firstLive = (f: Frame): number => Math.max(0, f.dead.indexOf(false));

/** Only the first live branch of every conditional kept (the live one after a dead `#if 0`). */
function firstBranches(text: string, cplusplus: boolean, macros?: BuildMacros): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => f.branch === firstLive(f), macros);
}

/** Only the second branch of every conditional kept, or its only one: what an `#else` defines for another platform. */
function secondBranches(text: string, cplusplus: boolean, macros?: BuildMacros): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, cplusplus, (f) => f.branch === (f.dead[0] ? firstLive(f) : Math.min(1, f.count - 1)), macros);
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

/** A front end's reading of a text; `also` is code the reading leaves out, lines in place, whose calls it counts. */
type Read = (text: string, also?: string) => ParsedStructure;

/**
 * A C-family file read as a compiler of the language would see it: without dead blocks, and, when that does not
 * parse, with only the first branch of every conditional (the other branches' calls counted where they fall), plus
 * the functions a second-branch reading defines where the first branches left nothing — another platform's `#else`.
 */
export function readWithBranches(text: string, cplusplus: boolean, read: Read, macros?: BuildMacros): ParsedStructure {
  const compiled = withoutDeadCode(text, cplusplus, macros);
  const first = read(compiled);
  if (first.syntaxErrors === 0) return first;
  const branches = firstBranches(compiled, cplusplus, macros);
  if (branches === compiled) return first;
  const second = read(branches, leftOut(compiled, branches));
  if (second.syntaxErrors > 0) return first;
  const others = secondBranches(compiled, cplusplus, macros);
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
