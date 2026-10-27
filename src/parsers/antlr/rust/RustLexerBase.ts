/*
 * The lexer predicates of grammars-v4's Rust grammar (rust/Antlr4ng/RustLexerBase.ts, MIT licence — see
 * grammars/antlr/rust/RustLexer.g4). Token types are looked up by name rather than imported from the lexer
 * that extends this class, so the two modules do not import each other.
 */
import { Lexer, Token, type CharStream } from "antlr4ng";

/** Tokens after which `.` is a member access, so `x.0.1` is not the float `0.1`. */
const NO_FLOAT_AFTER = [
  "CHAR_LITERAL", "STRING_LITERAL", "RAW_STRING_LITERAL", "BYTE_LITERAL", "BYTE_STRING_LITERAL",
  "RAW_BYTE_STRING_LITERAL", "INTEGER_LITERAL", "DEC_LITERAL", "HEX_LITERAL", "OCT_LITERAL", "BIN_LITERAL",
  "KW_SUPER", "KW_SELFVALUE", "KW_SELFTYPE", "KW_CRATE", "KW_DOLLARCRATE", "GT", "RCURLYBRACE", "RSQUAREBRACKET",
  "RPAREN", "KW_AWAIT", "NON_KEYWORD_IDENTIFIER", "RAW_IDENTIFIER", "KW_MACRORULES",
];

const code = (c: string): number => c.charCodeAt(0);

export abstract class RustLexerBase extends Lexer {
  /** The last two tokens on the default channel. */
  private lt1: Token | null = null;
  private lt2: Token | null = null;
  private noFloatAfter: Set<number> | null = null;
  private dot = -1;

  constructor(input: CharStream) {
    super(input);
  }

  override nextToken(): Token {
    const next = super.nextToken();
    if (next.channel === Token.DEFAULT_CHANNEL) {
      this.lt2 = this.lt1;
      this.lt1 = next;
    }
    return next;
  }

  /** The token being lexed starts the file (read after its `#!`). */
  protected AtFileStart(): boolean {
    return this.tokenStartCharIndex === 0;
  }

  /** After `1.`: a float unless a member or a `.`/`_` follows (`1.f32` and `1.f64` are floats). */
  protected FloatDotPossible(): boolean {
    const input = this.inputStream;
    const next = input.LA(1);
    if (next === code(".") || next === code("_")) return false;
    if (next === code("f")) {
      const suffix = String.fromCharCode(input.LA(2), input.LA(3));
      return suffix === "32" || suffix === "64";
    }
    const letter = (next >= code("a") && next <= code("z")) || (next >= code("A") && next <= code("Z"));
    return !letter;
  }

  /** Not a float right after `x.` (`tuple.0.1` indexes twice). */
  protected FloatLiteralPossible(): boolean {
    if (!this.lt1 || !this.lt2) return true;
    if (!this.noFloatAfter) {
      this.noFloatAfter = new Set(NO_FLOAT_AFTER.map((n) => this.getTokenType(n)));
      this.dot = this.getTokenType("DOT");
    }
    if (this.lt1.type !== this.dot) return true;
    return !this.noFloatAfter.has(this.lt2.type);
  }
}
