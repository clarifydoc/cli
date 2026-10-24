import { findEndLine } from "../shared/regex-base.js";

/**
 * Where Ruby's blocks end, read the way Ruby reads them: by keywords, not
 * indentation.
 *
 * The indentation guess ends a method at the first line indented no deeper
 * than its `def` — which is where a method-level `rescue` / `ensure` sits, so
 * every call in error handling fell outside the method. It also ends a class
 * at any unindented line: a heredoc body or a multi-line string at column 0,
 * an `=begin` block, a statement someone forgot to indent — and every method
 * after that point lost its class.
 *
 * This pass blanks what is not code (comments, `=begin`…`=end`, strings with
 * their `#{}`, heredoc bodies, `%w[]` / `%()` / `%r{}` literals, regex
 * literals, `?x` characters, everything after `__END__`), then runs one stack
 * over the whole file: `def` / `class` / `module` / `if` … at the start of a
 * statement, an expression `x = if …`, a `do`, a `{` open; `end` and `}`
 * close. A `def` whose `end` it finds gets that line; a file it cannot balance
 * keeps the indentation guess for whatever it could not close.
 */

/** 0-based index of a block's first line → 1-based line of its `end`. */
export type RubyBlockEnds = ReadonlyMap<number, number>;

const IDENT = /[A-Za-z0-9_]/;
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

interface Frame {
  kind: "code" | "literal";
  /** Literal: the closing delimiter, and the opening one when it nests (`%w[a [b] c]`). */
  close?: string;
  open?: string;
  depth: number;
  /** Literal: `#{…}` interpolates. Code: this is the inside of an interpolation. */
  interp: boolean;
  /** Literal: a regex, whose flags follow the closing delimiter. */
  regex?: boolean;
  /** Literal: ends at a newline (a `/…/` that was really division). */
  singleLine?: boolean;
  /** Literal: a plain quoted string kept as written (`keepQuoted`). */
  keep?: boolean;
  /** Code: an interpolation of a kept string, kept as code; the quote it reopens at its `}`. */
  reopen?: string;
}

export interface BlankOptions {
  /**
   * Plain `'…'` / `"…"` strings stay as written: the call patterns read
   * `render "x"` themselves, and blank strings on their own. Only what they
   * cannot see through is blanked.
   */
  keepQuoted?: boolean;
  /**
   * With `keepQuoted`: a kept string's `#{…}` is code the call scan should
   * read — `"a #{foo(x)} b"` becomes `"a " foo(x)" b"`, the string closed at
   * `#{` and reopened at `}`, every length unchanged.
   */
  interpolationAsCode?: boolean;
  /**
   * The character a literal is blanked to. A space by default; the block scan
   * uses a word character, so a removed string still reads as a value
   * (`sha = `…` if x` is a modifier, not `sha = if …`).
   */
  fill?: string;
}

/**
 * The source with every non-code character blanked, newlines kept so lines
 * and columns still line up. Comments and heredoc bodies become spaces;
 * literals become `fill`.
 */
export function blankRubyNonCode(source: string, options: BlankOptions = {}): string {
  const { keepQuoted = false, interpolationAsCode = false, fill = " " } = options;
  const out = source.split("");
  const blank = (from: number, to: number, ch = " "): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = ch;
  };
  const fillIn = (from: number, to: number): void => blank(from, to, fill);
  const stack: Frame[] = [{ kind: "code", depth: 0, interp: false }];
  const heredocs: Array<{ id: string; indented: boolean }> = [];

  let i = 0;
  while (i < source.length) {
    const frame = stack[stack.length - 1]!;
    const c = source[i]!;
    const lineStart = i === 0 || source[i - 1] === "\n";

    if (frame.kind === "literal") {
      const hide = (from: number, to: number): void => { if (!frame.keep) fillIn(from, to); };
      if (c === "\n" && frame.singleLine) { stack.pop(); continue; }
      if (c === "\\") { hide(i, i + 2); i += 2; continue; }
      if (frame.interp && c === "#" && source[i + 1] === "{") {
        if (frame.keep && interpolationAsCode) {
          out[i] = frame.close!;
          out[i + 1] = " ";
          stack.push({ kind: "code", depth: 0, interp: true, reopen: frame.close });
        } else {
          hide(i, i + 2);
          stack.push({ kind: "code", depth: 0, interp: true });
        }
        i += 2;
        continue;
      }
      if (frame.open && c === frame.open && frame.open !== frame.close) { frame.depth++; hide(i, i + 1); i++; continue; }
      if (c === frame.close) {
        if (frame.depth > 0) { frame.depth--; hide(i, i + 1); i++; continue; }
        let end = i + 1;
        if (frame.regex) while (end < source.length && /[a-z]/.test(source[end]!)) end++;
        hide(i, end);
        stack.pop();
        i = end;
        continue;
      }
      hide(i, i + 1);
      i++;
      continue;
    }

    // Code (the file's own, or the inside of a `#{…}`, which belongs to its string).
    const hidden = frame.interp && !frame.reopen;
    const keep = (n: number): void => { if (hidden) fillIn(i, i + n); i += n; };

    if (c === "\n") {
      i++;
      // The bodies of the heredocs this line opened, one after another.
      while (heredocs.length > 0 && i < source.length) {
        const doc = heredocs.shift()!;
        while (i < source.length) {
          const eol = source.indexOf("\n", i);
          const stop = eol === -1 ? source.length : eol;
          const text = source.slice(i, stop).replace(/\r$/, "");
          blank(i, stop);
          i = eol === -1 ? source.length : eol + 1;
          if ((doc.indented ? text.trim() : text) === doc.id) break;
        }
      }
      continue;
    }
    if (lineStart && !hidden) {
      if (source.startsWith("=begin", i) && !IDENT.test(source[i + 6] ?? "")) {
        const close = /\n=end(?![A-Za-z0-9_])[^\n]*/.exec(source.slice(i));
        const stop = close ? i + close.index + close[0].length : source.length;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (/^__END__\r?(?:\n|$)/.test(source.slice(i, i + 9))) {
        blank(i, source.length);
        break;
      }
    }
    if (c === "#") {
      const eol = source.indexOf("\n", i);
      const stop = eol === -1 ? source.length : eol;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (frame.interp && c === "{") { frame.depth++; keep(1); continue; }
    if (frame.interp && c === "}") {
      if (frame.depth > 0) { frame.depth--; keep(1); continue; }
      if (frame.reopen) out[i] = frame.reopen;
      else fillIn(i, i + 1);
      stack.pop();
      i++;
      continue;
    }
    // A global — `$?`, `$!`, `$"`, `$/`, `$0`, `$-w`, `$stdout` — is one token: its second
    // character starts no literal (`#{$?}` would otherwise read `?}` as a character).
    if (c === "$") {
      const global = /^\$(?:[!@&`'+~=\/\\,;.<>*$?:"]|-\w|\d+|[A-Za-z_]\w*)/.exec(source.slice(i, i + 64));
      if (global) { keep(global[0].length); continue; }
    }
    // ``def `(cmd)`` and ``:` `` name the backtick method; they open no shell string.
    if (c === "`" && (source[i - 1] === ":" || /\bdef\s+(?:self\.)?$/.test(source.slice(Math.max(0, i - 20), i)))) { keep(1); continue; }
    if (c === "\"" || c === "'" || c === "`") {
      const kept = keepQuoted && !hidden && c !== "`";
      if (!kept) fillIn(i, i + 1);
      stack.push({ kind: "literal", close: c, depth: 0, interp: c !== "'", keep: kept });
      i++;
      continue;
    }
    if (c === "?" && isCharLiteral(source, i)) {
      const len = source[i + 1] === "\\" ? 3 : 2;
      fillIn(i, i + len);
      i += len;
      continue;
    }
    if (c === "<" && source[i + 1] === "<") {
      const doc = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/.exec(source.slice(i, i + 80));
      if (doc && (doc[1] || doc[2] || (/^[A-Z_]/.test(doc[3]!) && valueExpected(source, i)))) {
        heredocs.push({ id: doc[3]!, indented: doc[1] !== "" });
        fillIn(i, i + doc[0].length);
        i += doc[0].length;
        continue;
      }
    }
    if (c === "%" && valueExpected(source, i)) {
      const lit = /^%([qQwWiIrsx]?)([^A-Za-z0-9\s])/.exec(source.slice(i, i + 3));
      if (lit) {
        const type = lit[1]!;
        const open = lit[2]!;
        const close = PAIRS[open] ?? open;
        fillIn(i, i + lit[0].length);
        stack.push({ kind: "literal", open, close, depth: 0, interp: /^[QWIrx]?$/.test(type), regex: type === "r" });
        i += lit[0].length;
        continue;
      }
    }
    if (c === "/" && valueExpected(source, i)) {
      fillIn(i, i + 1);
      // A `/x` regex may span lines; one read only as a paren-less argument (`split /,/`) is
      // as likely a division, and ends at the newline.
      stack.push({ kind: "literal", close: "/", depth: 0, interp: true, regex: true, singleLine: !operatorBefore(source, i) });
      i++;
      continue;
    }
    // A symbol or a method name that is a keyword (`:end`, `x.class`) stays code; the block scan skips it.
    keep(1);
  }
  return out.join("");
}

/**
 * Whether a value may start at `i`: after an operator or an opener, at the
 * start of a statement, after a keyword that takes one (`when /x/`), or as the
 * argument of a call written without parens (`split /,/`, `foo %w[a]`) — a
 * space before and none after.
 */
function valueExpected(source: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (source[k] === " " || source[k] === "\t")) k--;
  if (k < 0 || source[k] === "\n") return true;
  const prev = source[k]!;
  // `:%`, `:/` — a symbol naming an operator method, not a literal.
  if (prev === ":" && k === i - 1 && source[k - 1] !== ":") return false;
  if ("=(,[{|&!?:;+-*/%<>~^".includes(prev)) return true;
  if (!IDENT.test(prev)) return false;
  const word = /[A-Za-z_]\w*$/.exec(source.slice(Math.max(0, k - 30), k + 1))?.[0] ?? "";
  // `def %(other)`, `def /(x)` — the method's name.
  if (word === "def" || word === "alias" || word === "undef") return false;
  if (/^(?:if|unless|elsif|while|until|when|in|and|or|not|return|then|do|else|case|yield)$/.test(word)) return true;
  // `foo %w[a b]`, `split /,/`: an argument without parens — a space before, none after.
  const after = source[i + 1] ?? "";
  return k < i - 1 && after !== " " && after !== "=" && after !== "\n";
}

/** Whether an operator, an opener or the start of a line comes right before `i` — a value certainly follows. */
function operatorBefore(source: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (source[k] === " " || source[k] === "\t")) k--;
  return k < 0 || source[k] === "\n" || "=(,[{|&!?;+-*%<>~^".includes(source[k]!);
}

/** `?a`, `?\n` — a character literal, not the `?` of a ternary. */
function isCharLiteral(source: string, i: number): boolean {
  const prev = source[i - 1] ?? "\n";
  if (IDENT.test(prev) || prev === ")" || prev === "]" || prev === "}") return false;
  const next = source[i + 1] ?? "";
  if (next === "" || next === " " || next === "\n" || next === "\t") return false;
  const after = source[next === "\\" ? i + 3 : i + 2] ?? "";
  return !IDENT.test(after);
}

// ─── The block scan ─────────────────────────────────────────────────────────

/** Opens a block where a statement starts; `if` … `until` also as an expression. */
const STATEMENT_OPENER = /^(?:if|unless|while|until|for|case|begin|def|class|module)$/;
/** Opens a block as an expression too: `x = if …`, `items << if …`, `foo(case y …`. */
const EXPRESSION_OPENER = /^(?:if|unless|case|begin|while|until)$/;
/** After these a statement starts: `then if …`, `do |x| if …`, `{ if …`. */
const STARTS_STATEMENT = new Set(["then", "else", "do", "begin", "ensure", "{", "|", "("]);
/**
 * Words that end a value — `return if x`, `self if y`, `end if z` are modifiers. A keyword that
 * expects more (`and`, `then`, `in`) does not.
 */
const NOT_A_VALUE = new Set(["and", "or", "not", "then", "else", "elsif", "do", "begin", "ensure", "rescue", "when", "in", "if", "unless", "while", "until", "case", "for"]);
/** Visibility and other methods that take a `def` as their argument: `private def x … end`. */
const DEF_PREFIX = /^(?:[a-z_]\w*[?!]?\s+)+$/;

/**
 * Every token of a line: symbols (`:name=` whole, so its `=` is no assignment), words,
 * numbers, the multi-character operators (so a lone `=` is an assignment, never half of
 * `==` / `=>` / `<=`), and any other character on its own.
 */
const TOKEN = /(?<![:\w]):(?:[A-Za-z_]\w*(?:[?!]|=(?![=>~]))?|\[\]=?|(?!:)[-+*\/%<>=!~^&|]+@?)|[A-Za-z_]\w*[?!]?|\d[\w.]*|\|\||&&|===?|=~|=>|!=|!~|<=>?|>=|<<|>>|\*\*|::|&\.|\S/g;
/** A line ending in one of these goes on on the next: its first word continues the statement. */
const CONTINUES = new Set([",", "(", "[", "{", "|", "||", "&&", "=", "+", "-", "*", "/", "%", ".", "&.", "::", "?", ":", "and", "or", "not", "<<", "==", "!=", "=~", "<", ">", "<=", ">=", "**", "=>"]);

/** Whether `tok` ends a value, so that a following `if` / `while` is a modifier. */
function endsValue(tok: string): boolean {
  if (/^[A-Za-z_]/.test(tok)) return !NOT_A_VALUE.has(tok);
  return /^\d/.test(tok) || tok === ")" || tok === "]" || tok === "}";
}

interface Open {
  kind: string;
  line: number;
}

/**
 * Every `def` / `class` / `module` (and every other block) whose `end` the
 * scan finds, keyed by the 0-based line it starts on.
 */
export function rubyBlockEnds(lines: readonly string[]): RubyBlockEnds {
  return scanRubyBlocks(lines).ends;
}

/** The scan itself: the ends it found, and the blocks still open at the end of the file. */
export function scanRubyBlocks(lines: readonly string[]): { ends: RubyBlockEnds; open: ReadonlyArray<{ kind: string; line: number }> } {
  // Literals blank to a word character: a removed string still ends a value.
  const code = blankRubyNonCode(lines.join("\n"), { fill: "x" }).split("\n");
  const ends = new Map<number, number>();
  const stack: Open[] = [];

  /** The token a continued line goes on from (`foo(a,` → `,`; `x = \` → `=`). */
  let carried: string | null = null;
  for (let ln = 0; ln < code.length; ln++) {
    const text = code[ln]!;
    if (text.trim() === "") continue;
    /** The previous token decides whether a keyword starts a statement, an expression or nothing. */
    let prev: string | null = carried;
    carried = null;
    /** The current statement opened a loop: its `do` is the loop's, not a block. */
    let loopOpened = false;
    /** The next word names a method (`def end`) or the statement lists names (`alias eql? ==`). */
    let naming = false;
    let names = false;
    let stmtStart = 0;
    const tokens: string[] = [];
    for (const m of text.matchAll(TOKEN)) {
      const at = m.index!;
      const before = text[at - 1] ?? "";
      // An operator right after `:` is a symbol (`undef_method :==, :!=`): a value, not an operator.
      const tok = before === ":" && text[at - 2] !== ":" && !/^[A-Za-z_]/.test(m[0]!) ? "x" : m[0]!;
      tokens.push(tok);
      if (tok.length > 1 && tok[0] === ":" && tok !== "::") { prev = "x"; tokens[tokens.length - 1] = "x"; continue; }
      if (tok === ";") { prev = null; loopOpened = false; names = false; stmtStart = at + 1; continue; }
      if (names) { prev = "x"; continue; }
      if (naming) {
        // `def self.name` / `def name`: the name is no keyword, whatever it spells.
        if (/^[A-Za-z_]/.test(tok) && text[at + tok.length] !== ".") naming = false;
        else if (tok !== "." && !/^[A-Za-z_]/.test(tok)) naming = false;
        prev = "x";
        continue;
      }
      const after = text[at + tok.length] ?? "";
      // `x.end`, `:class`, `@do`, `if:` keys, `Foo::Bar` — names, not keywords.
      const member = before === "." || before === ":" || before === "@" || before === "$" || (after === ":" && text[at + tok.length + 1] !== ":");
      if (tok === "{") { stack.push({ kind: "{", line: ln }); prev = tok; continue; }
      if (tok === "}") {
        if (stack.length > 0 && stack[stack.length - 1]!.kind === "{") stack.pop();
        prev = tok;
        continue;
      }
      if (member || /[?!]$/.test(tok)) { prev = /^[A-Za-z_]/.test(tok) ? "x" : tok; continue; }
      const atStatementStart = prev === null || STARTS_STATEMENT.has(prev);
      if ((tok === "alias" || tok === "undef") && atStatementStart) { names = true; prev = "x"; continue; }
      if (tok === "end") {
        // An `end` closes the innermost keyword block; braces left open above it were unbalanced.
        while (stack.length > 0 && stack[stack.length - 1]!.kind === "{") stack.pop();
        const open = stack.pop();
        if (open) ends.set(open.line, ln + 1);
        prev = tok;
        continue;
      }
      if (tok === "def") {
        const head = text.slice(stmtStart, at);
        if (atStatementStart || DEF_PREFIX.test(head.trimStart())) {
          // An endless method (`def name = expr`) ends on its own line.
          if (isEndlessDef(text.slice(at))) ends.set(ln, ln + 1);
          else stack.push({ kind: "def", line: ln });
        }
        naming = true;
        prev = tok;
        continue;
      }
      // At a statement's start every opener opens; after an operator (`=`, `<<`, `||`, `(`, `,`)
      // an expression opener does; after a value (`return`, `x`, `)`) it is a modifier —
      // except `return case …` / `return begin …`.
      const singletonClass = tok === "class" && /^\s*<</.test(text.slice(at + 5)) && prev !== null && !endsValue(prev);
      const opens = STATEMENT_OPENER.test(tok) && atStatementStart || singletonClass
        || EXPRESSION_OPENER.test(tok) && prev !== null && (!endsValue(prev) || (prev === "return" && (tok === "case" || tok === "begin")));
      if (opens) {
        stack.push({ kind: tok, line: ln });
        if (tok === "while" || tok === "until" || tok === "for") loopOpened = true;
        prev = tok;
        continue;
      }
      if (tok === "do") {
        if (loopOpened) loopOpened = false;
        else stack.push({ kind: "do", line: ln });
        prev = tok;
        continue;
      }
      prev = tok;
    }
    // A line that ends in an operator goes on: `x = \` and `foo(a,` carry that operator, a `\`
    // after a value carries the value (a leading `if` on the next line is then its modifier).
    if (!names) {
      const last = tokens[tokens.length - 1] ?? null;
      const beforeLast = tokens[tokens.length - 2] ?? null;
      if (last === "\\") carried = beforeLast !== null && CONTINUES.has(beforeLast) ? beforeLast : "x";
      else if (last !== null && CONTINUES.has(last)) carried = last;
    }
  }
  return { ends, open: stack };
}

/** `def name(args) = expr` / `def name = expr` (Ruby 3 endless method) opens nothing; `def name=(v)` is a setter that does. */
function isEndlessDef(fromDef: string): boolean {
  return /^def\s+(?:[A-Za-z_]\w*\s*\.\s*)?(?:[A-Za-z_]\w*[?!]?|\[\]|[-+*\/%<>=!~^&|]+@?)(?:\s*\([^)]*\)\s*=|\s+=)(?![=~>])/.test(fromDef);
}

const memo = new WeakMap<readonly string[], RubyBlockEnds>();

/** `rubyBlockEnds`, computed once per file's lines. */
export function rubyBlockEndsOf(lines: readonly string[]): RubyBlockEnds {
  let ends = memo.get(lines);
  if (!ends) {
    ends = rubyBlockEnds(lines);
    memo.set(lines, ends);
  }
  return ends;
}

/**
 * 0-based index of the `end` of the block declared on line `i` — the exclusive
 * bound of its body — or the indentation guess for a block the scan could not close.
 */
export function rubyBodyEnd(lines: readonly string[], i: number): number {
  const end = rubyBlockEndsOf(lines).get(i);
  return end !== undefined ? end - 1 : findEndLine(lines as string[], i, "indent");
}

const codeMemo = new WeakMap<readonly string[], readonly string[]>();

/**
 * The file's lines for the call scan: heredoc bodies, `%w[]` / `%()` / `%r{}`
 * literals, comments and `=begin` blocks blanked; plain `'…'` / `"…"` strings
 * kept as written (the scan reads `render "x"` itself), their `#{…}` opened up
 * as code. Computed once per file.
 */
export function rubyCodeLinesOf(lines: readonly string[]): readonly string[] {
  let code = codeMemo.get(lines);
  if (!code) {
    code = blankRubyNonCode(lines.join("\n"), { keepQuoted: true, interpolationAsCode: true }).split("\n");
    codeMemo.set(lines, code);
  }
  return code;
}
