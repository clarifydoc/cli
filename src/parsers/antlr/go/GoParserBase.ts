/*
 * The semantic predicates of grammars-v4's Go grammar (golang/TypeScript/GoParserBase.ts, BSD licence — see
 * grammars/antlr/go/GoParser.g4), ported from the `antlr4` runtime to antlr4ng. Token types are read from the
 * lexer rather than the parser, so this module does not import the parser that extends it.
 *
 * Every predicate reads tokens only. Upstream's also read a table of the file's import names, and a
 * prediction the shared DFA cached for one file then misread the next (the same file parsed with or without
 * errors depending on what was parsed before it).
 */
import { Parser, type TokenStream } from "antlr4ng";
import { GoLexer } from "./GoLexer.js";

/** Tokens that can only start a type: after `(`, a conversion's parenthesized type. */
const TYPE_OPENERS: ReadonlySet<number> = new Set([GoLexer.L_BRACKET, GoLexer.MAP, GoLexer.CHAN, GoLexer.STRUCT, GoLexer.INTERFACE]);

export abstract class GoParserBase extends Parser {
  constructor(input: TokenStream) {
    super(input);
  }

  protected isNotReceive(): boolean {
    return this.inputStream.LT(2)?.type !== GoLexer.RECEIVE;
  }

  /** Anything but a parenthesized type (`([]*T)(nil)`, `(map[K]V)(m)`), which opens a conversion. */
  protected isOperand(): boolean {
    return !(this.inputStream.LA(1) === GoLexer.L_PAREN && TYPE_OPENERS.has(this.inputStream.LA(2)));
  }

  /** A conversion's type opens with a type literal (`[]byte(s)`); `T(x)` reads as a call. */
  protected isConversion(): boolean {
    return this.inputStream.LA(1) !== GoLexer.IDENTIFIER;
  }
}
