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

/** A synthesized node. Carries only what the interpreter reads. */
class SynthNode implements FlowNode {
  readonly id = nextId++;
  readonly isNamed = true;
  readonly startIndex: number;
  readonly children: SynthNode[] = [];
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
 */
export function blankNonCode(source: string, spec: LanguageRegexControlFlowSpec): string {
  const out = source.split("");
  const lineComments = spec.lineComments ?? ["//"];
  const blockComment = spec.blockComment ?? ["/*", "*/"];
  const quotes = spec.quotes ?? ['"', "'", "`"];

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i, i + 4);

    const line = lineComments.find((token) => rest.startsWith(token));
    if (line) {
      while (i < source.length && source[i] !== "\n") out[i++] = " ";
      continue;
    }

    if (blockComment[0] && rest.startsWith(blockComment[0])) {
      const end = source.indexOf(blockComment[1], i + blockComment[0].length);
      const stop = end === -1 ? source.length : end + blockComment[1].length;
      for (; i < stop; i++) if (source[i] !== "\n") out[i] = " ";
      continue;
    }

    // A regex literal, told from division by what precedes it: an operator or
    // an opener means a value is expected here, and only a literal can start
    // with `/` in that position. Imperfect by construction, and far better
    // than letting `/\{/` count as an open brace.
    if (spec.regexLiterals && source[i] === "/" && expectsValue(source, i)) {
      const end = regexLiteralEnd(source, i);
      if (end > i) {
        for (; i < end; i++) if (source[i] !== "\n") out[i] = " ";
        continue;
      }
    }

    const quote = quotes.find((q) => source.startsWith(q, i));
    if (quote) {
      out[i] = " ";
      i += quote.length;
      while (i < source.length) {
        if (source[i] === "\\") {
          out[i] = " ";
          if (i + 1 < source.length && source[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source.startsWith(quote, i)) {
          for (let k = 0; k < quote.length; k++) out[i + k] = " ";
          i += quote.length;
          break;
        }
        // A newline inside what looked like a string means it was not one
        // (an apostrophe in a comment, a lifetime tick in Rust). Stop there
        // rather than blanking the rest of the function.
        if (source[i] === "\n" && !spec.multilineStrings) break;
        out[i] = " ";
        i++;
      }
      continue;
    }

    i++;
  }
  return out.join("");
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

  const openers = spec.blockOpen ?? /\{/g;
  const closers = spec.blockClose ?? /\}/g;

  const lines: ScanLine[] = [];
  let depth = 0;
  for (let i = 0; i < raws.length && i < MAX_LINES; i++) {
    const code = codes[i] ?? "";
    const opens = (code.match(new RegExp(openers.source, "g")) ?? []).length;
    const closes = (code.match(new RegExp(closers.source, "g")) ?? []).length;
    // A line that closes then reopens (`} else {`) belongs to the outer level,
    // so the depth recorded is the one before any of it ran, less the closes
    // it starts with.
    const leadingCloses = /^\s*/.exec(code)![0].length === code.length ? 0 : countLeading(code, closers);
    lines.push({
      row: firstRow + i,
      raw: raws[i] ?? "",
      code,
      depth: depth - leadingCloses,
      delta: opens - closes,
    });
    depth += opens - closes;
  }
  return lines;
}

/** How many closers the line starts with, before any other code. */
function countLeading(code: string, closer: RegExp): number {
  const single = new RegExp(`^\\s*(?:${closer.source}\\s*)+`);
  const hit = single.exec(code);
  if (!hit) return 0;
  return (hit[0].match(new RegExp(closer.source, "g")) ?? []).length;
}

interface Matched {
  /** Canonical node type the shared role table already names. */
  type: string;
  /** The controlling expression, when the pattern captured one. */
  head?: string;
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
function splitInline(code: string): { head: string; tail: string } | null {
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
function classify(code: string, spec: LanguageRegexControlFlowSpec): Matched | null {
  const trimmed = code.trim();
  if (trimmed === "") return null;
  for (const rule of spec.statements) {
    const hit = rule.match.exec(trimmed);
    if (hit) return { type: rule.type, head: hit[1]?.trim() };
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

    const matched = classify(line.code, spec);
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
      into.add(node("expression_statement", line, lines[bodyEnd - 1]!));
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
    .replace(new RegExp(open.source, "g"), "")
    .replace(new RegExp(close.source, "g"), "")
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
  return new SynthNode(
    type,
    text ?? start.raw.trim(),
    { row: start.row, column: 0 },
    { row: end.row, column: (end.raw || "").length },
  );
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
  const inline = bodyEnd === i + 1 ? splitInline(line.code.trim()) : null;

  const withBody = (type: string, field: string): SynthNode => {
    const head = inline?.head ?? matched.head;
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
      for (const part of inline.tail.split(";")) {
        const text = part.trim();
        if (text === "") continue;
        const as = { ...line, code: text, raw: text, delta: 0 };
        block.add(node(classify(text, spec)?.type ?? "expression_statement", as, as));
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
    const elseIf = (spec.elseIf ?? /^\}?\s*(?:else\s+if|elif|elsif)\b\s*\(?([^){]*)/).exec(
      line.code.trim(),
    );
    const plainElse = (spec.else ?? /^\}?\s*else\s*\{?\s*$/).test(line.code.trim());

    if (elseIf) {
      const start = index;
      const { from, end } = bodyRange(lines, start, to, spec);
      if (end <= at && start < at) return at; // no progress: stop rather than loop
      const inner = node("if_statement", line, lines[Math.max(start, end - 1)]!, elseIf[1]?.trim() ?? "");
      inner.add(node("condition", line, line, elseIf[1]?.trim() ?? ""), "condition");
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
      const isCatch = (spec.catch ?? /^\}?\s*(?:catch|rescue|except)\b/).test(trimmed);
      const isFinally = (spec.finally ?? /^\}?\s*(?:finally|ensure)\b/).test(trimmed);
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
  const label = spec.case ?? /^(?:case\s+([^:]*)|default)\s*:?/;

  const starts: { index: number; text: string | undefined }[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    if (line.depth > (lines[from]?.depth ?? 0)) continue;
    const hit = label.exec(line.code.trim());
    if (hit) starts.push({ index: i, text: hit[1]?.trim() });
  }

  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]!.index : to;
    const line = lines[start.index]!;
    const lastLine = lines[Math.max(start.index, end - 1)]!;
    const isDefault = start.text === undefined;
    const arm = node(isDefault ? "switch_default" : "switch_case", line, lastLine, start.text ?? "default");
    if (!isDefault) arm.add(node("value", line, line, start.text!), "value");
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
  if (!spec) return null;

  const all = source.split("\n");
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
    if (here.depth === 0 && next.depth > here.depth) start = i + 1;
  }
  if (start === 0 && lines.length > 0 && lines[0]!.code.includes("{")) {
    // The whole method on one line — `public int getId() { return id; }`, which
    // is most of a Java model class. There is no block to descend into, so the
    // statements between the braces are read directly.
    const code = lines[0]!.code;
    const open = code.indexOf("{");
    const close = code.lastIndexOf("}");
    const inner = close > open ? code.slice(open + 1, close) : "";
    for (const part of inner.split(";")) {
      const text = part.trim();
      if (text === "") continue;
      const as = { ...lines[0]!, code: text, raw: text, delta: 0 };
      root.add(node(classify(text, spec)?.type ?? "expression_statement", as, as));
    }
    return finish(root);
  }
  parseRange(lines, start, lines.length, spec, 0, root);
  return finish(root);

  function finish(body: SynthNode): Cfg {
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

}
