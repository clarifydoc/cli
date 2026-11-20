import { Token, type CharStream } from "antlr4ng";

import { RustLexer } from "./RustLexer.js";

/** What the first pass remembers of one bracket pair, or of the file for the bottom frame. */
interface Frame {
  /** A condition (`if`, `while`, `match`, `for … in`) is read and its block's `{` has not come. */
  pending: boolean;
  /** The condition so far holds a `let` or `for` pattern whose `=` / `in` has not come: a `{` there is the pattern's. */
  pattern: boolean;
  /** An item's header (`fn`, `impl`, `struct`, …) is read and its body's `{` or its `;` has not come. */
  header: "item" | "enum" | null;
  /** A `->` was read and the `{` after the type it returns is a closure's body. */
  arrow: boolean;
  /** This frame is an enum's body, whose `Variant {` is a declaration. */
  enumBody: boolean;
}

const frame = (enumBody = false): Frame => ({ pending: false, pattern: false, header: null, arrow: false, enumBody });

/**
 * The reader's lexer: the Rust lexer, with the `{` of a struct literal retyped as `STRUCT_LBRACE`. After a path a `{`
 * opens either a struct literal or, in the head of an `if`, `while` or `match`, the block; SLL prediction, which does
 * not know where an expression stands, cannot tell them, and a file with `Json(Club { id })` in it failed that pass and
 * was read again by full-context prediction, five times slower. Rust itself decides by position, and so does this
 * class, from the tokens before the brace alone: an identifier before a `{` that is not the block of a condition, of
 * an item or of a closure with a return type, and not inside a macro's or an attribute's tokens (which stay a balanced
 * token tree). A brace it leaves as it was still reads either way, so a wrong guess costs a second reading, not a
 * different tree — the caller reads again with the plain lexer when this one's does not parse.
 */
export class RustReadLexer extends RustLexer {
  private readonly frames: Frame[] = [frame()];
  /** The last three tokens on the default channel, newest first. */
  private last = [-1, -1, -1];
  /** Brackets still open inside a macro's or an attribute's tokens; 0 outside one. */
  private skipping = 0;

  constructor(input: CharStream) {
    super(input);
  }

  override nextToken(): Token {
    const token = super.nextToken();
    if (token.channel === Token.DEFAULT_CHANNEL) this.see(token);
    return token;
  }

  private see(token: Token): void {
    const type = token.type;
    const [prev, prev2, prev3] = this.last;
    this.last = [type, prev!, prev2!];
    const open = type === RustLexer.LPAREN || type === RustLexer.LSQUAREBRACKET || type === RustLexer.LCURLYBRACE;
    const close = type === RustLexer.RPAREN || type === RustLexer.RSQUAREBRACKET || type === RustLexer.RCURLYBRACE;
    if (this.skipping > 0) {
      if (open) this.skipping++;
      else if (close) this.skipping--;
      return;
    }
    if (open && this.startsTokenTree(type, prev!, prev2!, prev3!)) {
      this.skipping = 1;
      return;
    }
    const top = this.frames[this.frames.length - 1]!;
    switch (type) {
      case RustLexer.LPAREN:
      case RustLexer.LSQUAREBRACKET:
        this.frames.push(frame());
        return;
      case RustLexer.RPAREN:
      case RustLexer.RSQUAREBRACKET:
      case RustLexer.RCURLYBRACE:
        if (this.frames.length > 1) this.frames.pop();
        return;
      case RustLexer.KW_IF:
      case RustLexer.KW_WHILE:
      case RustLexer.KW_MATCH:
        top.pending = true;
        top.pattern = false;
        return;
      case RustLexer.KW_FOR:
        // `impl Trait for Club`, `for<'a>`: part of a header, not a loop.
        if (top.header) return;
        top.pending = true;
        top.pattern = true;
        return;
      case RustLexer.KW_LET:
        if (top.pending) top.pattern = true;
        return;
      case RustLexer.EQ:
      case RustLexer.KW_IN:
        if (top.pending) top.pattern = false;
        return;
      case RustLexer.FATARROW:
        top.pending = false;
        top.pattern = false;
        return;
      case RustLexer.SEMI:
        top.header = null;
        top.arrow = false;
        return;
      case RustLexer.KW_ENUM:
        top.header ??= "enum";
        return;
      case RustLexer.KW_FN:
      case RustLexer.KW_IMPL:
      case RustLexer.KW_STRUCT:
      case RustLexer.KW_TRAIT:
      case RustLexer.KW_MOD:
      case RustLexer.KW_UNION:
      case RustLexer.KW_EXTERN:
        top.header ??= "item";
        return;
      case RustLexer.RARROW:
        if (!top.header) top.arrow = true;
        return;
      case RustLexer.LCURLYBRACE:
        this.frames.push(frame(top.header === "enum"));
        if (top.header) top.header = null;
        else if (top.pending && top.pattern) return;
        else if (top.pending) top.pending = false;
        else if (top.arrow) top.arrow = false;
        else if (!top.enumBody && (prev === RustLexer.NON_KEYWORD_IDENTIFIER || prev === RustLexer.RAW_IDENTIFIER || prev === RustLexer.KW_SELFTYPE)) {
          (token as { type: number }).type = RustLexer.STRUCT_LBRACE;
        }
        return;
    }
  }

  /** A `(`, `[` or `{` opening a macro invocation's, a `macro_rules!` body's or an attribute's tokens. */
  private startsTokenTree(type: number, prev: number, prev2: number, prev3: number): boolean {
    if (prev === RustLexer.NOT) return true;
    if (type === RustLexer.LSQUAREBRACKET && prev === RustLexer.POUND) return true;
    return prev === RustLexer.NON_KEYWORD_IDENTIFIER && prev2 === RustLexer.NOT && prev3 === RustLexer.KW_MACRORULES;
  }
}
