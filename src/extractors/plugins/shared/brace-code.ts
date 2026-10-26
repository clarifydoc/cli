import { findEndLine } from "./regex-base.js";

/**
 * Brace-language source read the way its compiler reads it before the regex
 * passes count braces or look for calls.
 *
 * Counting `{` and `}` on raw lines goes wrong at the first brace inside a
 * string, a rune, a raw string or a comment — `"{"`, `'}'`, a JSON template in
 * a raw string, a commented-out block — and every function after that point
 * ends early or swallows its neighbour. The call scan has the same problem one
 * level up: it blanks a quoted string on one line, but a raw string or a block
 * comment spanning lines reads as code, so the SQL or HTML inside it becomes
 * calls (`COALESCE(`, `alert(`).
 *
 * A `BraceLexicon` names a language's literal forms; `blankCode` blanks them
 * (and comments) keeping every other character where it was, newlines
 * included, so line and column numbers survive.
 */
export interface BraceLexicon {
  /** Line-comment tokens (`//`). */
  lineComments: readonly string[];
  /** Block comment delimiters; `nests` when a comment opened inside a comment needs its own close (Rust, Swift, Scala). */
  blockComment?: { open: string; close: string; nests?: boolean };
  /**
   * String forms, longest opener first (`"""` before `"`). `escapes`: a
   * backslash escapes the next character. `multiline`: the literal may span
   * lines (otherwise a newline ends it, which is how an unterminated quote in
   * odd code stays harmless).
   */
  strings: readonly { open: string; close: string; escapes: boolean; multiline: boolean }[];
  /**
   * A literal whose delimiters are computed — Rust `r#"…"#`, C++ `R"x(…)x"`,
   * Swift `#"…"#`: the index just past it when one starts at `i`, else -1.
   */
  rawString?: (text: string, i: number) => number;
  /** `'x'`, `'\n'`, `'\u{1F600}'` are character literals; any other `'` (a Rust lifetime, a Scala symbol) is code. */
  charLiterals?: boolean;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;
const CHAR_LITERAL = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)|[^\\'\n])'/y;

/**
 * `text` with comments and literals blanked. With `keepSingleLine`, a string
 * that opens and closes on one line stays as written (the call scan blanks
 * those itself and its call patterns may read them); everything spanning
 * lines, raw strings and comments are blanked either way.
 */
export function blankCode(text: string, lex: BraceLexicon, keepSingleLine = false): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const block = lex.blockComment;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (block && text.startsWith(block.open, i)) {
      let depth = 1;
      let k = i + block.open.length;
      while (k < text.length && depth > 0) {
        if (block.nests && text.startsWith(block.open, k)) { depth++; k += block.open.length; continue; }
        if (text.startsWith(block.close, k)) { depth--; k += block.close.length; continue; }
        k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    if (lex.lineComments.some((t) => text.startsWith(t, i))) {
      let k = i;
      while (k < text.length && text[k] !== "\n") k++;
      blank(i, k);
      i = k;
      continue;
    }
    // A raw string starts a token: its prefix (`r`, `R`, `u8R`) is never the tail of an identifier.
    if (lex.rawString && (i === 0 || !IDENT_CHAR.test(text[i - 1]!))) {
      const end = lex.rawString(text, i);
      if (end > i) {
        blank(i, end);
        i = end;
        continue;
      }
    }
    if (c === "'" && lex.charLiterals) {
      CHAR_LITERAL.lastIndex = i;
      const m = CHAR_LITERAL.exec(text);
      if (m) {
        if (!keepSingleLine) blank(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }
    const form = lex.strings.find((s) => text.startsWith(s.open, i));
    if (form) {
      let k = i + form.open.length;
      let closed = false;
      let spans = false;
      while (k < text.length) {
        if (form.escapes && text[k] === "\\") { if (text[k + 1] === "\n") spans = true; k += 2; continue; }
        if (text.startsWith(form.close, k)) { k += form.close.length; closed = true; break; }
        if (text[k] === "\n") {
          if (!form.multiline) break;
          spans = true;
        }
        k++;
      }
      if (!(keepSingleLine && closed && !spans)) blank(i, k);
      i = k;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 0-based line of a declaration → 1-based line its block ends on, read over blanked code. */
class LazyEnds extends Map<number, number> {
  constructor(private readonly code: string[]) {
    super();
  }
  override get(i: number): number | undefined {
    let end = super.get(i);
    if (end === undefined && i >= 0 && i < this.code.length) {
      end = findEndLine(this.code, i, "brace");
      super.set(i, end);
    }
    return end;
  }
}

export interface BraceCodeHooks {
  /** `RegexLangSpec.blockEnds`: brace matching over code only. */
  blockEnds: (lines: readonly string[]) => ReadonlyMap<number, number>;
  /** `RegexLangSpec.callSourceLines`: multi-line literals and comments blanked, one-line strings kept. */
  callSourceLines: (lines: readonly string[]) => readonly string[];
  /** The lines with comments and multi-line literals blanked, one-line strings kept — what a route scan reads. */
  commentFreeLines: (lines: readonly string[]) => readonly string[];
  /**
   * Whether line `i` starts in code — not inside a block comment or a raw string
   * (a commented-out function, a code template in a string): a function
   * pattern's `accept`.
   */
  startsInCode: (lines: readonly string[], i: number) => boolean;
}

/**
 * The hooks a brace language's `RegexLangSpec` takes from its lexicon,
 * computed once per file. `callCode` may rewrite the call scan's lines
 * further (blank a keyword that reads like a call, Go's `func(`).
 */
export function braceCodeHooks(lex: BraceLexicon, callCode?: (line: string) => string): BraceCodeHooks {
  const blanked = new WeakMap<readonly string[], string[]>();
  const ends = new WeakMap<readonly string[], ReadonlyMap<number, number>>();
  const kept = new WeakMap<readonly string[], readonly string[]>();
  const calls = new WeakMap<readonly string[], readonly string[]>();
  const keptOf = (lines: readonly string[]): readonly string[] => {
    let k = kept.get(lines);
    if (!k) {
      k = blankCode(lines.join("\n"), lex, true).split("\n");
      kept.set(lines, k);
    }
    return k;
  };
  const codeOf = (lines: readonly string[]): string[] => {
    let code = blanked.get(lines);
    if (!code) {
      code = blankCode(lines.join("\n"), lex).split("\n");
      blanked.set(lines, code);
    }
    return code;
  };
  return {
    blockEnds(lines) {
      let e = ends.get(lines);
      if (!e) {
        e = new LazyEnds(codeOf(lines));
        ends.set(lines, e);
      }
      return e;
    },
    callSourceLines(lines) {
      let c = calls.get(lines);
      if (!c) {
        const code = keptOf(lines);
        c = callCode ? code.map(callCode) : code;
        calls.set(lines, c);
      }
      return c;
    },
    commentFreeLines: keptOf,
    startsInCode(lines, i) {
      const raw = lines[i] ?? "";
      const at = raw.search(/\S/);
      return at < 0 || (codeOf(lines)[i] ?? "")[at] === raw[at];
    },
  };
}
