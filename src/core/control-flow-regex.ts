import type { Language } from "../types/analysis.js";
import type { Cfg, FlowNode } from "../types/control-flow.js";
import type {
  ControlFlowField,
  LanguageRegexControlFlowSpec,
} from "../types/language-plugin.js";
import { complexityFor, regexControlFlowFor } from "../extractors/registry.js";
import { DEFAULT_COMPLEXITY } from "../extractors/shared/complexity-defaults.js";
import {
  DEFAULT_CONTROL_FLOW,
  DEFAULT_CONTROL_FLOW_FIELDS,
} from "../extractors/shared/control-flow-defaults.js";
import { buildFromBody, type FunctionRef } from "./control-flow.js";

/**
 * Control flow for languages with no parser.
 *
 * Two thirds of the languages here are extracted by regex — Go, Rust, Ruby,
 * Swift, C, C++, Dart and the rest — because no `web-tree-sitter`-loadable
 * grammar was viable for them. They still have functions, with accurate start
 * and end lines, and their bodies are still ordinary structured code. What is
 * missing is only the tree.
 *
 * So this builds one. A line scanner reads the function's source, strips what
 * would lie to it (comments, string literals), tracks nesting through the
 * language's block delimiters, and emits nodes carrying the SAME canonical
 * types the shared role table already names — `if_statement`, `while_statement`,
 * `else_clause`. Those go to the same interpreter the tree-sitter tier uses.
 *
 * That is the whole design: not a second builder, which would drift from the
 * first the moment either was fixed, but a second front end for the one that
 * exists. Everything downstream — the merge collapsing, the `finally` detour,
 * the Mermaid renderer, the webview — is reached unchanged.
 *
 * **What it cannot do.** It does not parse, so it cannot be certain. A
 * construct the patterns do not name reads as a plain statement; a brace
 * inside something the stripper missed shifts the nesting; a one-line `if`
 * with no block is a branch whose body it has to guess at. Graphs from here
 * are marked `approximate`, and every surface that shows one says so. An
 * approximation a reader can discount is useful; one presented as a parse is
 * not.
 */

/**
 * Lines that open a function of their own: a declaration, an arrow body, a Go
 * `func` literal, a Rust or Ruby closure. Deliberately broad — the cost of a
 * false positive is one block drawn as a single step, the cost of a miss is a
 * callback's control flow mixed into its caller's.
 */
const DEFAULT_NESTED_FUNCTION =
  /(?:\bfunction\b|=>\s*\{\s*$|\bfunc\s*\(|\bfn\s+\w+\s*\(|\|[^|]*\|\s*\{\s*$|\bdo\s*\|)/;

/** Nesting deeper than this is a runaway, not a function. */
const MAX_DEPTH = 40;

/** Lines past this in one function and the scan gives up rather than crawl. */
const MAX_LINES = 4000;

let nextId = 1;

/**
 * Marks a spec copy used for measuring (`regexStructureMetrics`): closures are
 * descended into as `nested_function` nodes rather than drawn as one step,
 * because the parsed tier's cognitive complexity counts what they contain, one
 * level deeper. Carried on the spec every scan function already receives.
 */
const MEASURE = Symbol("measure");
type ScanSpec = LanguageRegexControlFlowSpec & { [MEASURE]?: true };
const MEASURING = new WeakMap<LanguageRegexControlFlowSpec, ScanSpec>();
function measuring(spec: LanguageRegexControlFlowSpec): ScanSpec {
  let copy = MEASURING.get(spec);
  if (!copy) MEASURING.set(spec, (copy = { ...spec, [MEASURE]: true }));
  return copy;
}

const DEFAULT_CATCH = /^\}?\s*(?:catch|rescue|except)\b/;
const DEFAULT_FINALLY = /^\}?\s*(?:finally|ensure)\b/;

/** Compiled variants of a spec's patterns, built once per pattern rather than per line. */
const GLOBAL = new WeakMap<RegExp, RegExp>();
const LEADING = new WeakMap<RegExp, RegExp>();

/** The same pattern, global, keeping its other flags (VB's keywords are case-insensitive). */
function globalOf(re: RegExp): RegExp {
  let g = GLOBAL.get(re);
  if (!g) GLOBAL.set(re, (g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")));
  return g;
}

/** A run of `closer` at the start of a line. */
function leadingOf(closer: RegExp): RegExp {
  let l = LEADING.get(closer);
  if (!l) LEADING.set(closer, (l = new RegExp(`^\\s*(?:${closer.source}\\s*)+`, closer.flags.replace("g", ""))));
  return l;
}

/** A synthesized node. Carries only what the interpreter reads. */
class SynthNode implements FlowNode {
  readonly id = nextId++;
  readonly isNamed = true;
  readonly startIndex: number;
  readonly children: SynthNode[] = [];
  /** The first line's comment- and string-blanked text, for counting operators. */
  code = "";
  private readonly fields = new Map<string, SynthNode>();

  constructor(
    readonly type: string,
    readonly text: string,
    readonly startPosition: { row: number; column: number },
    readonly endPosition: { row: number; column: number },
  ) {
    // Only ever compared for ordering within one synthesized body.
    this.startIndex = startPosition.row * 4096 + startPosition.column;
  }

  get childCount(): number {
    return this.children.length;
  }

  child(index: number): SynthNode | null {
    return this.children[index] ?? null;
  }

  childForFieldName(fieldName: string): SynthNode | null {
    return this.fields.get(fieldName) ?? null;
  }

  fieldNameForChild(index: number): string | null {
    const child = this.children[index];
    if (!child) return null;
    for (const [name, node] of this.fields) {
      if (node === child) return name;
    }
    return null;
  }

  /** Add a child, optionally under a field name the interpreter asks for. */
  add(child: SynthNode, field?: string): SynthNode {
    this.children.push(child);
    if (field !== undefined) this.fields.set(field, child);
    return child;
  }
}

/**
 * Blank out comments and string literals, keeping every other character where
 * it was.
 *
 * Positions have to survive because the scan reports source lines, and lengths
 * have to survive because the brace counting is positional. Blanking rather
 * than deleting does both. This is also what stops `// if (x) {` and
 * `"}"` from moving the nesting — the single largest source of nonsense in a
 * scanner like this.
 *
 * With `keepStrings`, string and regex literals are skipped rather than
 * blanked: comments go, and the text a label shows stays as written.
 */
export function blankNonCode(source: string, spec: LanguageRegexControlFlowSpec, keepStrings = false): string {
  // One byte a character says which ones become spaces; an array of the
  // characters cost eight, and a long function's went to the large-object space.
  const blanked = new Uint8Array(source.length);
  const lineComments = spec.lineComments ?? ["//"];
  const blockComment = spec.blockComment ?? ["/*", "*/"];
  const quotes = spec.quotes ?? ['"', "'", "`"];
  // Whether a comment or a quote can start at a character is first a question of the character: most
  // start neither, and pass without a lookup (and the closure each lookup made).
  const tokens = [...lineComments, ...quotes];
  const starts = tokens.every((t) => t.length > 0) ? new Set(tokens.map((t) => t[0]!)) : undefined;

  let i = 0;
  while (i < source.length) {
    // A block comment first: Lua's `--[[` begins with its line-comment token.
    if (blockComment[0] && source.startsWith(blockComment[0], i)) {
      const end = source.indexOf(blockComment[1], i + blockComment[0].length);
      const stop = end === -1 ? source.length : end + blockComment[1].length;
      for (; i < stop; i++) if (source[i] !== "\n") blanked[i] = 1;
      continue;
    }

    const opens = starts === undefined || starts.has(source[i]!);
    const line = opens ? lineComments.find((token) => source.startsWith(token, i)) : undefined;
    if (line) {
      while (i < source.length && source[i] !== "\n") blanked[i++] = 1;
      continue;
    }

    // A regex literal, told from division by what precedes it: an operator or
    // an opener means a value is expected here, and only a literal can start
    // with `/` in that position. Imperfect by construction, and far better
    // than letting `/\{/` count as an open brace.
    if (spec.regexLiterals && source[i] === "/" && expectsValue(source, i)) {
      const end = regexLiteralEnd(source, i);
      if (end > i) {
        for (; i < end; i++) if (source[i] !== "\n" && !keepStrings) blanked[i] = 1;
        continue;
      }
    }

    const quote = opens ? quotes.find((q) => source.startsWith(q, i)) : undefined;
    if (quote) {
      const blank = keepStrings ? () => {} : (at: number) => void (blanked[at] = 1);
      blank(i);
      i += quote.length;
      while (i < source.length) {
        if (source[i] === "\\") {
          blank(i);
          if (i + 1 < source.length && source[i + 1] !== "\n") blank(i + 1);
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) {
          for (let k = 0; k < quote.length; k++) blank(i + k);
          i += quote.length;
          break;
        }
        // A newline inside what looked like a string means it was not one
        // (an apostrophe in a comment, a lifetime tick in Rust). Stop there
        // rather than blanking the rest of the function.
        if (source[i] === "\n" && !spec.multilineStrings) break;
        blank(i);
        i++;
      }
      continue;
    }

    i++;
  }
  // Kept runs as slices, blanked runs as spaces.
  let out = "";
  let at = 0;
  while (at < source.length) {
    const from = at;
    const blank = blanked[at];
    while (at < source.length && blanked[at] === blank) at++;
    out += blank ? " ".repeat(at - from) : source.slice(from, at);
  }
  return out;
}

/** Whether a value (and so possibly a regex literal) may begin at `i`. */
function expectsValue(source: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const c = source[k]!;
    if (c === " " || c === "\t") continue;
    if (c === "\n") return true;
    if ("=(,:[!&|?{};+*%<>~^".includes(c)) return true;
    // `return /re/`, `case /re/`, `typeof /re/`
    return /\b(?:return|case|typeof|in|of|do|else|yield|await)$/.test(source.slice(Math.max(0, k - 9), k + 1));
  }
  return true;
}

/** The index just past a regex literal starting at `i`, or `i` if it is not one. */
function regexLiteralEnd(source: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < source.length; k++) {
    const c = source[k]!;
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "\n") return i; // a literal cannot span lines: it was division
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      // Trailing flags belong to the literal.
      let end = k + 1;
      while (end < source.length && /[a-z]/.test(source[end]!)) end++;
      return end;
    }
  }
  return i;
}

/** One source line, with the bookkeeping the scan needs. */
interface ScanLine {
  /** 0-based row within the file. */
  row: number;
  /** The original text, for labels. */
  raw: string;
  /** Comment- and string-blanked text, for matching and counting. */
  code: string;
  /** Comment-blanked text with its strings kept, for the labels a pattern captures. */
  shown: string;
  /** Nesting depth before this line runs. */
  depth: number;
  /** Depth change this line causes. */
  delta: number;
}

/**
 * Turn the function's source into `ScanLine`s: comments and strings blanked
 * for matching, and the nesting depth before and after each line inferred by
 * counting the language's block openers and closers.
 *
 * @param source - The function's text
 * @param firstRow - 0-based row of its first line within the file
 * @param spec - The language's regex control-flow tables
 */
function scanLines(
  source: string,
  firstRow: number,
  spec: LanguageRegexControlFlowSpec,
): ScanLine[] {
  const blanked = blankNonCode(source, spec);
  const raws = source.split("\n");
  const codes = blanked.split("\n");
  const shown = blankNonCode(source, spec, true).split("\n");

  if (spec.blockDelta) return scanKeywordLines(raws, codes, shown, firstRow, spec);

  const openers = spec.blockOpen ?? /\{/g;
  const closers = spec.blockClose ?? /\}/g;

  const lines: ScanLine[] = [];
  let depth = 0;
  for (let i = 0; i < raws.length && i < MAX_LINES; i++) {
    const code = codes[i] ?? "";
    const opens = (code.match(globalOf(openers)) ?? []).length;
    const closes = (code.match(globalOf(closers)) ?? []).length;
    // A line that closes then reopens (`} else {`) belongs to the outer level,
    // so the depth recorded is the one before any of it ran, less the closes
    // it starts with.
    const leadingCloses = /^\s*/.exec(code)![0].length === code.length ? 0 : countLeading(code, closers);
    lines.push({
      row: firstRow + i,
      raw: raws[i] ?? "",
      code,
      shown: shown[i] ?? "",
      depth: depth - leadingCloses,
      delta: opens - closes,
    });
    depth += opens - closes;
  }
  return lines;
}

/**
 * `scanLines` for keyword-delimited languages: the plugin's `blockDelta` says what
 * each line opens, `blockClose` what it closes, and a stack of block names decides whether a
 * `middle` line (`else`, `rescue`) steps out to its block's level or — inside an
 * `armBlocks` block such as a Ruby `case` — is one more arm at the arms' level.
 */
function scanKeywordLines(
  raws: readonly string[],
  codes: readonly string[],
  shown: readonly string[],
  firstRow: number,
  spec: LanguageRegexControlFlowSpec,
): ScanLine[] {
  const lines: ScanLine[] = [];
  const stack: string[] = [];
  const closer = spec.blockClose ?? /\}/;
  for (let i = 0; i < raws.length && i < MAX_LINES; i++) {
    const code = codes[i] ?? "";
    const trimmed = code.trim();
    const delta = trimmed === "" ? { open: [] } : spec.blockDelta!(trimmed);
    const close = trimmed === "" ? 0 : (trimmed.match(globalOf(closer)) ?? []).length;
    const leadingClose = close === 0 ? 0 : countLeading(trimmed, closer);
    const depth = stack.length;
    const asArm = delta.middle && spec.armBlocks?.has(stack[stack.length - 1] ?? "");
    const recorded = delta.middle && !asArm ? Math.max(0, depth - 1) : Math.max(0, depth - leadingClose);
    for (let k = 0; k < close && stack.length > 0; k++) stack.pop();
    for (const name of delta.open) if (stack.length < MAX_DEPTH * 2) stack.push(name);
    lines.push({ row: firstRow + i, raw: raws[i] ?? "", code, shown: shown[i] ?? "", depth: recorded, delta: stack.length - depth });
  }
  return lines;
}

/** How many closers the line starts with, before any other code. */
function countLeading(code: string, closer: RegExp): number {
  const hit = leadingOf(closer).exec(code);
  if (!hit) return 0;
  return (hit[0].match(globalOf(closer)) ?? []).length;
}

interface Matched {
  /** Canonical node type the shared role table already names. */
  type: string;
  /** The controlling expression, when the pattern captured one. */
  head?: string;
  /** The construct runs its body when `head` is false (`unless`, `until`). */
  negated?: boolean;
}

const JUMPS: ReadonlySet<string> = new Set([
  "return_statement",
  "throw_statement",
  "break_statement",
  "continue_statement",
]);

/**
 * Where a construct's block actually lives.
 *
 * Two brace styles to serve. K&R puts the brace on the construct's own line
 * (`if (x) {`), Allman puts it on the next one — and Allman is the house style
 * of most C# and a good deal of C and Java, so a scanner that only understood
 * K&R would read every `try` in a C# file as having an empty body and every
 * `catch` as unattached.
 */
function bodyRange(
  lines: readonly ScanLine[],
  i: number,
  to: number,
  spec: LanguageRegexControlFlowSpec,
): { from: number; end: number } {
  const direct = blockEnd(lines, i, to);
  if (direct > i + 1) return { from: i + 1, end: direct };

  const next = lines[i + 1];
  if (next && isPunctuationOnly(next.code, spec) && next.code.includes("{")) {
    return { from: i + 2, end: blockEnd(lines, i + 1, to) };
  }
  return { from: i + 1, end: direct };
}

/** One statement written inline on `line` (`if x then return`, `when 1 then go`), classified by its blanked `code`, labelled by its `shown` text. */
function inlineStatement(code: string, shown: string, line: ScanLine, spec: LanguageRegexControlFlowSpec): SynthNode {
  const as = { ...line, code, raw: shown, shown, delta: 0 };
  return node(classify(code, spec)?.type ?? "expression_statement", as, as);
}

/**
 * The text a label shows for `length` characters at `start` of the trimmed blanked line.
 *
 * Patterns run on the blanked line, where a string is spaces: `if role == 'keeper'`
 * captures `role ==`, and `msg += "x" unless y` captures `msg +=`. Blanking keeps
 * every character in place, so the span is read from `shown` (strings kept) after
 * widening it over the blanked run on either side — out to the next code, never
 * past it.
 */
function shownSpan(code: string, shown: string, start: number, length: number): string {
  const lead = code.length - code.trimStart().length;
  let from = lead + start;
  let to = from + length;
  while (from > 0 && /\s/.test(code[from - 1]!)) from--;
  while (to < code.length && /\s/.test(code[to]!)) to++;
  return shown.slice(from, to).trim();
}

/** `shownSpan` for a capture `text` known only by its value: its first place in the trimmed blanked line. */
function shownOf(code: string, shown: string, text: string): string {
  const at = code.trim().indexOf(text);
  return at === -1 ? text : shownSpan(code, shown, at, text.length);
}

/** Capture `group` of a `withIndices` hit on the trimmed blanked line, as `shown` reads it. */
function shownCapture(hit: RegExpExecArray, group: number, code: string, shown: string): string | undefined {
  const at = hit.indices?.[group];
  if (!at) return hit[group]?.trim();
  return shownSpan(code, shown, at[0], at[1] - at[0]);
}

const WITH_INDICES = new WeakMap<RegExp, RegExp>();
/** `re` with the `d` flag, so a hit carries its captures' offsets; built once per pattern. */
function withIndices(re: RegExp): RegExp {
  let out = WITH_INDICES.get(re);
  if (!out) {
    out = new RegExp(re.source, `${re.flags.replace(/[gyd]/g, "")}d`);
    WITH_INDICES.set(re, out);
  }
  return out;
}

/** A condition read the other way round: the body of `unless x` runs when `!x` holds. */
function negation(head: string): string {
  return /^[\w@$.:?!]+(?:\([^()]*\)|\[[^[\]]*\])*$/.test(head) ? `!${head}` : `!(${head})`;
}

/** Whether this construct leaves the enclosing statement sequence outright. */
function isJump(matched: Matched | null): boolean {
  return matched !== null && JUMPS.has(matched.type);
}


/**
 * Split `if (cond) doSomething();` into its condition and the statement it
 * guards.
 *
 * The brace-less form is not a rare flourish — this repo's own TypeScript has
 * 1,754 of them, and before this the condition and the statement were both
 * read as one ordinary line, losing a branch and a `return` each time. It is
 * the single largest thing standing between the scanner and the parse tree.
 *
 * Balanced-paren scanning rather than a pattern, because a condition can
 * contain parentheses (`if (a(b) > 0) return;`) and no regex can match those.
 */
function splitInline(code: string): { head: string; tail: string; negated?: boolean } | null {
  const open = code.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) {
        const head = code.slice(open + 1, i).trim();
        const tail = code.slice(i + 1).trim().replace(/^\{\s*/, "").replace(/\}\s*$/, "").trim();
        return tail === "" ? null : { head, tail };
      }
    }
  }
  return null;
}

/**
 * Match one blanked line against the spec's statement rules, first hit wins.
 * Returns the canonical node type and the captured head (condition), or null
 * for a line no rule describes.
 */
function classify(code: string, spec: LanguageRegexControlFlowSpec, shown = code): Matched | null {
  const trimmed = code.trim();
  if (trimmed === "") return null;
  for (const rule of spec.statements) {
    const hit = withIndices(rule.match).exec(trimmed);
    if (hit) return { type: rule.type, head: shownCapture(hit, 1, code, shown), negated: rule.negated };
  }
  return null;
}

/**
 * Turn a run of lines into statements.
 *
 * Recursive by depth: a line that opens a block owns every following line
 * deeper than it, up to the one that closes back. That is the whole nesting
 * model, and it is why the comment and string blanking above is not optional.
 */
function parseRange(
  lines: readonly ScanLine[],
  from: number,
  to: number,
  spec: LanguageRegexControlFlowSpec,
  depth: number,
  into: SynthNode,
): void {
  if (depth > MAX_DEPTH) return;
  let i = from;

  while (i < to) {
    const line = lines[i]!;
    // Blank lines, and lines that are nothing but the punctuation closing a
    // block. A `}` on its own is where a construct ended, not a step in it.
    if (line.code.trim() === "" || isPunctuationOnly(line.code, spec)) {
      i++;
      continue;
    }

    const matched = classify(line.code, spec, line.shown);
    const range = bodyRange(lines, i, to, spec);
    const bodyEnd = range.end;

    // A callback or a nested function: the tree-sitter tier stops at that
    // boundary and reports what is inside as hidden, so this one does too.
    // Without it every `return` in every `.map(x => { … })` is read as an exit
    // from the enclosing function.
    //
    // A jump wins over it, though. `return new Promise((resolve) => {` both
    // opens a callback and returns, and the return is the part that belongs to
    // the function being drawn.
    const nested = spec.nestedFunction ?? DEFAULT_NESTED_FUNCTION;
    if (bodyEnd > i + 1 && nested.test(line.code) && !isJump(matched)) {
      if ((spec as ScanSpec)[MEASURE]) {
        const closure = node("nested_function", line, lines[bodyEnd - 1]!);
        parseRange(lines, range.from, bodyEnd, spec, depth + 1, closure);
        into.add(closure);
      } else {
        into.add(node("expression_statement", line, lines[bodyEnd - 1]!));
      }
      i = bodyEnd;
      continue;
    }
    // A jump that also opens a block leaves regardless of what is inside it.
    if (isJump(matched) && bodyEnd > i + 1) {
      into.add(node(matched!.type, line, lines[bodyEnd - 1]!));
      i = bodyEnd;
      continue;
    }

    if (!matched) {
      // Straight-line code. A construct the patterns do not name lands here
      // too, which is why its block is still walked rather than swallowed.
      into.add(node("expression_statement", line, line));
      i = bodyEnd > i + 1 ? bodyEnd : i + 1;
      continue;
    }

    i = emit(lines, i, range, to, spec, depth, into, matched);
  }
}

/**
 * Whether the line carries no code — only the delimiters that open or close a
 * block, and the punctuation that can trail them (`};`, `}),`).
 */
function isPunctuationOnly(code: string, spec: LanguageRegexControlFlowSpec): boolean {
  const open = spec.blockOpen ?? /\{/;
  const close = spec.blockClose ?? /\}/;
  const stripped = code
    .replace(globalOf(open), "")
    .replace(globalOf(close), "")
    .replace(/[\s;,()\[\]]/g, "");
  return stripped === "";
}

/**
 * The line index just past the block this line opens (or `i + 1`).
 *
 * Decided by where the following lines sit, not by the line's own brace
 * arithmetic: `} else if (cond) {` closes one block and opens another, so its
 * net delta is zero while it plainly opens something. Reading the depth of
 * what comes next is the only version of this that is right for both.
 */
function blockEnd(lines: readonly ScanLine[], i: number, to: number): number {
  const line = lines[i]!;
  const next = lines[i + 1];
  if (!next || next.depth <= line.depth) return i + 1;
  let j = i + 1;
  while (j < to && lines[j]!.depth > line.depth) j++;
  return j;
}

/**
 * Make a synthetic node of `type` spanning `start`..`end`, labelled by the
 * first line's raw text unless `text` is given.
 */
function node(type: string, start: ScanLine, end: ScanLine, text?: string): SynthNode {
  const n = new SynthNode(
    type,
    text ?? start.raw.trim(),
    { row: start.row, column: 0 },
    { row: end.row, column: (end.raw || "").length },
  );
  n.code = start.code;
  return n;
}

/** Emit one construct and return the line index to continue from. */
function emit(
  lines: readonly ScanLine[],
  i: number,
  range: { from: number; end: number },
  to: number,
  spec: LanguageRegexControlFlowSpec,
  depth: number,
  into: SynthNode,
  matched: Matched,
): number {
  const line = lines[i]!;
  const bodyEnd = range.end;
  const last = lines[Math.max(i, bodyEnd - 1)]!;

  // `if (cond) return;` — the construct and its whole body on one line, with
  // no block to descend into. Only consulted when no block was opened, so a
  // braced form is never second-guessed.
  const inline = bodyEnd === i + 1 ? (spec.inlineGuard?.(line.code.trim()) ?? splitInline(line.code.trim())) : null;

  const withBody = (type: string, field: string): SynthNode => {
    const written = inline ? shownOf(line.code, line.shown, inline.head) : matched.head;
    const head = written !== undefined && (inline ? inline.negated : matched.negated) ? negation(written) : written;
    const owner = node(type, line, last, head ?? line.raw.trim());
    if (head !== undefined) {
      owner.add(node("condition", line, line, head), "condition");
    }
    const block = node("statement_block", line, last, "");
    if (inline) {
      // The guarded statements are classified in their own right, so
      // `if (x) return null;` yields a branch AND the exit it guards — and
      // `if (x) { flag = false; continue; }`, which is two statements on one
      // line, does not quietly lose the `continue`.
      let at = line.code.trim().indexOf(inline.tail);
      for (const part of inline.tail.split(";")) {
        const text = part.trim();
        if (text !== "") {
          const shown = at === -1 ? text : shownSpan(line.code, line.shown, at, part.length);
          block.add(inlineStatement(text, shown, line, spec));
        }
        if (at !== -1) at += part.length + 1;
      }
    } else {
      parseRange(lines, range.from, bodyEnd, spec, depth + 1, block);
    }
    owner.add(block, field);
    return owner;
  };

  switch (matched.type) {
    case "if_statement": {
      const owner = withBody("if_statement", "consequence");
      into.add(owner);
      return chainElse(lines, bodyEnd, to, spec, depth, owner);
    }
    case "while_statement":
    case "for_statement":
      into.add(withBody(matched.type, "body"));
      return bodyEnd;
    case "do_statement": {
      // `do { … } while (cond);` — the test is on the closing line.
      const owner = withBody("do_statement", "body");
      const closing = lines[bodyEnd - 1];
      const tail = closing ? /\bwhile\s*\(([^)]*)\)/.exec(closing.code) : null;
      if (tail) owner.add(node("condition", closing!, closing!, tail[1]!.trim()), "condition");
      into.add(owner);
      return bodyEnd;
    }
    case "switch_statement": {
      const owner = node("switch_statement", line, last, matched.head ?? line.raw.trim());
      if (matched.head !== undefined) {
        owner.add(node("value", line, line, matched.head), "value");
      }
      owner.add(switchBody(lines, range.from, bodyEnd, spec, depth), "body");
      into.add(owner);
      return bodyEnd;
    }
    case "try_statement": {
      const owner = withBody("try_statement", "body");
      into.add(owner);
      return chainHandlers(lines, bodyEnd, to, spec, depth, owner);
    }
    case "return_statement":
    case "throw_statement":
    case "break_statement":
    case "continue_statement":
      into.add(node(matched.type, line, line));
      return i + 1;
    default:
      into.add(node("expression_statement", line, line));
      return bodyEnd > i + 1 ? bodyEnd : i + 1;
  }
}

/** Attach `else if` / `else` arms that follow an `if`'s closing line. */
function chainElse(
  lines: readonly ScanLine[],
  at: number,
  to: number,
  spec: LanguageRegexControlFlowSpec,
  depth: number,
  owner: SynthNode,
): number {
  // The `else` may share the `if`'s closing line (`} else {`) or start the
  // next one; both spellings are common and neither is worth a setting.
  for (const index of [at - 1, at]) {
    if (index < 0 || index >= to) continue;
    const line = lines[index]!;
    const elseIf = withIndices(spec.elseIf ?? /^\}?\s*(?:else\s+if|elif|elsif)\b\s*\(?([^){]*)/).exec(
      line.code.trim(),
    );
    const plainElse = (spec.else ?? /^\}?\s*else\s*\{?\s*$/).test(line.code.trim());

    if (elseIf) {
      const start = index;
      const { from, end } = bodyRange(lines, start, to, spec);
      if (end <= at && start < at) return at; // no progress: stop rather than loop
      const head = shownCapture(elseIf, 1, line.code, line.shown) ?? "";
      const inner = node("if_statement", line, lines[Math.max(start, end - 1)]!, head);
      inner.add(node("condition", line, line, head), "condition");
      const block = node("statement_block", line, lines[Math.max(start, end - 1)]!, "");
      parseRange(lines, from, end, spec, depth + 1, block);
      inner.add(block, "consequence");
      owner.add(inner, "alternative");
      return chainElse(lines, end, to, spec, depth, inner);
    }

    if (plainElse) {
      const start = index;
      const { from, end } = bodyRange(lines, start, to, spec);
      if (end <= at && start < at) return at;
      const clause = node("else_clause", line, lines[Math.max(start, end - 1)]!, "else");
      const block = node("statement_block", line, lines[Math.max(start, end - 1)]!, "");
      parseRange(lines, from, end, spec, depth + 1, block);
      clause.add(block, "body");
      owner.add(clause, "alternative");
      return end;
    }
  }
  return at;
}

/** Attach `catch` / `finally` arms that follow a `try`'s closing line. */
function chainHandlers(
  lines: readonly ScanLine[],
  at: number,
  to: number,
  spec: LanguageRegexControlFlowSpec,
  depth: number,
  owner: SynthNode,
): number {
  let cursor = at;
  for (let guard = 0; guard < 8; guard++) {
    let advanced = false;
    for (const index of [cursor - 1, cursor]) {
      if (index < 0 || index >= to) continue;
      const line = lines[index]!;
      const trimmed = line.code.trim();
      const isCatch = (spec.catch ?? DEFAULT_CATCH).test(trimmed);
      const isFinally = (spec.finally ?? DEFAULT_FINALLY).test(trimmed);
      if (!isCatch && !isFinally) continue;

      const { from, end } = bodyRange(lines, index, to, spec);
      if (end <= cursor && index < cursor) continue;
      const lastLine = lines[Math.max(index, end - 1)]!;
      const clause = node(isCatch ? "catch_clause" : "finally_clause", line, lastLine, trimmed);
      const block = node("statement_block", line, lastLine, "");
      parseRange(lines, from, end, spec, depth + 1, block);
      clause.add(block, "body");
      owner.add(clause);
      cursor = end;
      advanced = true;
      break;
    }
    if (!advanced) break;
  }
  return cursor;
}

/** A switch body: each `case`/`default` label owns the lines up to the next. */
function switchBody(
  lines: readonly ScanLine[],
  from: number,
  to: number,
  spec: LanguageRegexControlFlowSpec,
  depth: number,
): SynthNode {
  const body = node(
    "switch_body",
    lines[from] ?? lines[Math.max(0, from - 1)]!,
    lines[Math.max(from, to - 1)] ?? lines[Math.max(0, from - 1)]!,
    "",
  );
  const label = withIndices(spec.case ?? /^(?:case\s+([^:]*)|default)\s*:?/);

  const starts: { index: number; text: string | undefined; inline?: { code: string; shown: string } }[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    if (line.depth > (lines[from]?.depth ?? 0)) continue;
    const hit = label.exec(line.code.trim());
    if (!hit) continue;
    // A label that is only a string literal (`when 'Contact'`) was blanked to spaces: read it from the raw line.
    // A second capture is the arm's statement on the label's own line (`{:error, e} -> raise e`, `when 1 then x`).
    const text = hit[1] === undefined ? undefined : shownCapture(hit, 1, line.code, line.shown) || line.raw.trim();
    const inline = hit[2]?.trim() ? { code: hit[2].trim(), shown: shownCapture(hit, 2, line.code, line.shown)! } : undefined;
    starts.push({ index: i, text, inline });
  }

  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]!.index : to;
    const line = lines[start.index]!;
    const lastLine = lines[Math.max(start.index, end - 1)]!;
    const isDefault = start.text === undefined;
    const arm = node(isDefault ? "switch_default" : "switch_case", line, lastLine, start.text ?? "default");
    if (!isDefault) arm.add(node("value", line, line, start.text!), "value");
    if (start.inline) arm.add(inlineStatement(start.inline.code, start.inline.shown, line, spec));
    parseRange(lines, start.index + 1, end, spec, depth + 1, arm);
    body.add(arm);
  });
  return body;
}

/**
 * Build a control-flow graph for one function from its source text.
 *
 * Returns `null` when the language declares no regex control-flow spec — the
 * same refusal the tree-sitter tier gives, and for the same reason: no tables
 * means no way to be right, and a guess is worse than nothing.
 */
export function buildRegexControlFlow(
  source: string,
  language: Language,
  fn: FunctionRef,
  filePath: string,
): Cfg | null {
  const spec = regexControlFlowFor(language);
  const body = spec ? buildRegexBody(source.split("\n"), spec, fn) : null;
  if (!body) return null;
  return buildFromBody(body, {
    spec: DEFAULT_CONTROL_FLOW,
    complexity: complexityFor(language) ?? DEFAULT_COMPLEXITY,
    fields: { ...DEFAULT_CONTROL_FLOW_FIELDS } as Record<ControlFlowField, readonly string[]>,
    language,
    fn,
    filePath,
    approximate: true,
  });
}

/** A language's logical operators (its complexity table) as one global pattern. */
const LOGICAL_BY_LANGUAGE = new Map<string, RegExp | null>();
function logicalOpsOf(language: Language): RegExp | null {
  if (LOGICAL_BY_LANGUAGE.has(language)) return LOGICAL_BY_LANGUAGE.get(language)!;
  const ops = [...((complexityFor(language) ?? DEFAULT_COMPLEXITY).logicalOps ?? [])];
  const re = ops.length === 0 ? null : new RegExp(
    ops.map((op) => (/^\w+$/.test(op) ? `\\b${op}\\b` : op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("|"),
    "g",
  );
  LOGICAL_BY_LANGUAGE.set(language, re);
  return re;
}

const TERNARY = /(?<=\s)\?(?=\s)/g;
const TERNARY_NODES = /^(?:ternary_expression|conditional_expression)$/;

/** Spaced `a ? b : c` operators in blanked code, for a language whose complexity table counts them (else 0). */
export function ternaryCount(code: string, language: Language): number {
  return countsTernaries(language) ? (code.match(TERNARY) ?? []).length : 0;
}

/** Whether the language's complexity table counts a conditional expression as a branch. */
function countsTernaries(language: Language): boolean {
  return [...(complexityFor(language) ?? DEFAULT_COMPLEXITY).branchNodes].some((t) => TERNARY_NODES.test(t));
}

/**
 * Cognitive complexity and nesting depth read off the same synthesized structure
 * the graph is drawn from — what a regex-path language had no way to report.
 * Cognitive follows the parsed tier's rules (`measureBody` in complexity-analyzer.ts):
 * a branch, loop, switch or `catch` adds 1 plus its nesting; an `else`/`else if`
 * continuation adds 1 without it; every logical operator adds 1; a closure deepens
 * the nesting of what it contains. `lines` is the whole file, split once;
 * `logical` is the language's operator pattern (default: its complexity table's).
 */
export function regexStructureMetrics(
  lines: readonly string[],
  language: Language,
  fn: FunctionRef,
  logical: RegExp | null = logicalOpsOf(language),
): { cognitive: number; nestingDepth: number } | null {
  const spec = regexControlFlowFor(language);
  const body = spec ? buildRegexBody(lines, measuring(spec), fn) : null;
  if (!body) return null;
  let cognitive = 0;
  let deepest = 0;
  const ternary = countsTernaries(language);
  const count = (n: SynthNode | null): void => {
    if (n && logical) cognitive += (n.text.match(globalOf(logical)) ?? []).length;
  };
  /** `a ? b : c`, spaced as written in code (not Rust's `x?`, TS's `x?:` or `?.`): a branch at the statement's nesting. */
  const ternaries = (n: SynthNode, nesting: number): void => {
    if (!ternary) return;
    const k = (n.code.match(TERNARY) ?? []).length;
    if (k === 0) return;
    cognitive += k * (1 + nesting);
    deepest = Math.max(deepest, nesting + 1);
  };
  /** A construct that adds 1 plus its nesting and deepens what it holds. */
  const enter = (nesting: number): void => {
    cognitive += 1 + nesting;
    deepest = Math.max(deepest, nesting + 1);
  };
  const walk = (n: SynthNode, nesting: number): void => {
    switch (n.type) {
      case "nested_function":
        count(n);
        for (const c of n.children) walk(c, nesting + 1);
        return;
      case "expression_statement":
      case "return_statement":
      case "throw_statement":
        count(n);
        ternaries(n, nesting);
        return;
      case "if_statement":
        enter(nesting);
        ifChain(n, nesting);
        return;
      case "while_statement":
      case "for_statement":
      case "do_statement":
      case "switch_statement":
      case "catch_clause":
        enter(nesting);
        count(n.childForFieldName("condition"));
        for (const c of n.children) if (c.type !== "condition" && c.type !== "value") walk(c, nesting + 1);
        return;
      default:
        for (const c of n.children) walk(c, nesting);
    }
  };
  /** An `if` and its `else if` / `else` arms: the arms add 1 each, without a nesting penalty. */
  const ifChain = (n: SynthNode, nesting: number): void => {
    count(n.childForFieldName("condition"));
    const consequence = n.childForFieldName("consequence");
    if (consequence) walk(consequence, nesting + 1);
    const alt = n.childForFieldName("alternative");
    if (alt?.type === "if_statement") {
      cognitive += 1;
      ifChain(alt, nesting);
    } else if (alt) {
      cognitive += 1;
      for (const c of alt.children) walk(c, nesting + 1);
    }
  };
  walk(body, 0);
  return { cognitive, nestingDepth: deepest };
}

/** The function's body (rows `fn.line`..`fn.endLine` of the file's `all` lines) as synthesized statements. */
function buildRegexBody(all: readonly string[], spec: ScanSpec, fn: FunctionRef): SynthNode | null {
  const first = Math.max(0, fn.line - 1);
  const last = Math.min(all.length, fn.endLine);
  if (last <= first) return null;

  const body = all.slice(first, last).join("\n");
  const lines = scanLines(body, first, spec);
  if (lines.length === 0) return null;

  // Where the body starts. Usually the declaration line opens it, but a
  // signature can run over several lines before the brace arrives, and
  // starting in the middle of one reads the parameter list as statements.
  const root = node("statement_block", lines[0]!, lines[lines.length - 1]!, "");
  //
  // The brace wanted is the LAST one at the outermost level before the body —
  // a signature can open braces of its own on the way (`): Promise<{` for an
  // inline return type), and taking the first would read the type's members
  // as statements.
  let start = 0;
  for (let i = 0; i < Math.min(lines.length - 1, 12); i++) {
    const here = lines[i]!;
    const next = lines[i + 1]!;
    if (here.depth === 0 && next.depth > here.depth) {
      start = i + 1;
      // A keyword language's signature opens nothing of its own: the first opener
      // is the body, and a later one at depth 0 is a `rescue` arm of it.
      if (spec.blockDelta) break;
    }
  }
  if (start === 0 && lines.length > 0 && lines[0]!.code.includes("{")) {
    // The whole method on one line — `public int getId() { return id; }`, which
    // is most of a Java model class. There is no block to descend into, so the
    // statements between the braces are read directly.
    const code = lines[0]!.code;
    const open = code.indexOf("{");
    const close = code.lastIndexOf("}");
    const inner = close > open ? code.slice(open + 1, close) : "";
    let at = open + 1 - (code.length - code.trimStart().length);
    for (const part of inner.split(";")) {
      const text = part.trim();
      if (text !== "") root.add(inlineStatement(text, shownSpan(code, lines[0]!.shown, at, part.length), lines[0]!, spec));
      at += part.length + 1;
    }
    return root;
  }
  // `def x … rescue … ensure … end`: a handler at the function's own level makes
  // the whole body before it a protected block (Ruby, Elixir `def … rescue`).
  if (spec.blockDelta) {
    const catchRe = spec.catch ?? DEFAULT_CATCH;
    const finallyRe = spec.finally ?? DEFAULT_FINALLY;
    const k = lines.findIndex((l, idx) => idx >= start && l.depth === 0 && (catchRe.test(l.code.trim()) || finallyRe.test(l.code.trim())));
    if (k > start) {
      const owner = node("try_statement", lines[start]!, lines[lines.length - 1]!, "");
      const block = node("statement_block", lines[start]!, lines[k - 1]!, "");
      parseRange(lines, start, k, spec, 1, block);
      owner.add(block, "body");
      root.add(owner);
      const after = chainHandlers(lines, k, lines.length, spec, 0, owner);
      parseRange(lines, after, lines.length, spec, 0, root);
      return root;
    }
  }
  parseRange(lines, start, lines.length, spec, 0, root);
  return root;
}
