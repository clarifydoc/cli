/*
 * The parser predicates of grammars-v4's Rust grammar (rust/Antlr4ng/RustParserBase.ts, MIT licence — see
 * grammars/antlr/rust/RustParser.g4): `>>` and `<<` lexed as one token are split back into two when a generic
 * closes. They read tokens only.
 */
import { Parser, type TokenStream } from "antlr4ng";
import { RustLexer } from "./RustLexer.js";

export abstract class RustParserBase extends Parser {
  constructor(input: TokenStream) {
    super(input);
  }

  protected NextGT(): boolean {
    return this.inputStream.LA(1) === RustLexer.GT;
  }

  protected NextLT(): boolean {
    return this.inputStream.LA(1) === RustLexer.LT;
  }
}
