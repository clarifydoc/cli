/*
 * The semantic predicate of grammars-v4's Lua grammar (lua/TypeScript/LuaParserBase.ts, MIT licence — see
 * grammars/antlr/lua/LuaParser.g4), ported from the `antlr4` runtime to antlr4ng.
 */
import { Parser, type TokenStream } from "antlr4ng";
import { LuaLexer } from "./LuaLexer.js";

/** Tokens that open a call's arguments, or a `:method` call, right after a name path. */
const CALL_OPENERS: ReadonlySet<number> = new Set([
  LuaLexer.OP, LuaLexer.COL, LuaLexer.OCU, LuaLexer.NORMALSTRING, LuaLexer.CHARSTRING, LuaLexer.LONGSTRING,
]);

export abstract class LuaParserBase extends Parser {
  constructor(input: TokenStream) {
    super(input);
  }

  /**
   * True when the name path starting here (`a.b[c].d`) is NOT called — despite the name, the guard of the
   * plain-variable alternative. Upstream looked only at the token after the first name, so
   * `gio.File.open(p):read()` read as the variable `gio.File.open` followed by a new statement `(p):read()`.
   */
  protected IsFunctionCall(): boolean {
    const stream = this.inputStream;
    if (stream.LA(1) !== LuaLexer.NAME) return false;
    let k = 2;
    for (;;) {
      const t = stream.LA(k);
      if (t === LuaLexer.DOT && stream.LA(k + 1) === LuaLexer.NAME) k += 2;
      else if (t === LuaLexer.OB) {
        // Skip a balanced `[ … ]`.
        let depth = 0;
        do {
          const u = stream.LA(k++);
          if (u === LuaLexer.OB) depth++;
          else if (u === LuaLexer.CB) depth--;
          else if (u === -1) return true;
        } while (depth > 0);
      } else return !CALL_OPENERS.has(t);
    }
  }
}
