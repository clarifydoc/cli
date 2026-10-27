/*
 * The lexer actions of grammars-v4's Lua grammar (lua/TypeScript/LuaLexerBase.ts, MIT licence — see
 * grammars/antlr/lua/LuaLexer.g4), ported from the `antlr4` runtime to antlr4ng: a `--` comment runs to the
 * end of the line, or to the matching `]=*]` when it opens a long bracket.
 */
import { Lexer, type CharStream, type LexerATNSimulator } from "antlr4ng";

const LF = 10;
const OPEN = 91; // '['
const CLOSE = 93; // ']'
const EQ = 61; // '='

export abstract class LuaLexerBase extends Lexer {
  constructor(input: CharStream) {
    super(input);
  }

  private consumeChar(cs: CharStream): void {
    (this.interpreter as LexerATNSimulator).consume(cs);
  }

  protected HandleComment(): void {
    const cs = this.inputStream;
    if (cs.LA(1) === OPEN) {
      const sep = this.skipSep(cs);
      if (sep >= 2) {
        this.readLongString(cs, sep);
        return;
      }
    }
    while (cs.LA(1) !== LF && cs.LA(1) !== -1) this.consumeChar(cs);
  }

  private readLongString(cs: CharStream, sep: number): void {
    this.consumeChar(cs);
    for (;;) {
      const c = cs.LA(1);
      if (c === -1) return;
      if (c === CLOSE) {
        if (this.skipSep(cs) === sep) {
          this.consumeChar(cs);
          return;
        }
        continue;
      }
      this.consumeChar(cs);
    }
  }

  private skipSep(cs: CharStream): number {
    let count = 0;
    const s = cs.LA(1);
    this.consumeChar(cs);
    while (cs.LA(1) === EQ) {
      this.consumeChar(cs);
      count++;
    }
    if (cs.LA(1) === s) count += 2;
    else if (count === 0) count = 1;
    else count = 0;
    return count;
  }

  protected IsLine1Col0(): boolean {
    return this.inputStream.index === 1;
  }
}
