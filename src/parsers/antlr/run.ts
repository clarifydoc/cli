import {
  BailErrorStrategy,
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  DefaultErrorStrategy,
  PredictionMode,
  type Lexer,
  type Parser,
  type ParserRuleContext,
} from "antlr4ng";

/**
 * The text the lexer reads: lines as `splitLines` counts them (ANTLR counts only `\n`, and a CR-only file would
 * read as one line), without a byte-order mark, which is no token of any grammar. Token offsets index this text.
 */
export function normalizeSource(source: string): string {
  return source.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}

/** Counts the syntax errors a lexer or parser reports, instead of printing them. */
class ErrorCounter extends BaseErrorListener {
  count = 0;
  override syntaxError(): void {
    this.count++;
  }
}

export interface AntlrParse<T extends ParserRuleContext> {
  tree: T;
  /** Lexer and parser errors together: a file with any was not read as the grammar reads it. */
  errors: number;
}

/**
 * Parses `source` with a generated lexer and parser, starting at `entry`: first with SLL prediction and a
 * parser that gives up at the first error — the fast path, exact whenever it succeeds — and again with full
 * LL only when that fails, which is what reports the errors.
 */
export function parseWithAntlr<P extends Parser, T extends ParserRuleContext>(
  source: string,
  makeLexer: (input: CharStream) => Lexer,
  makeParser: (tokens: CommonTokenStream) => P,
  entry: (parser: P) => T,
): AntlrParse<T> {
  const lexer = makeLexer(CharStream.fromString(normalizeSource(source)));
  const errors = new ErrorCounter();
  lexer.removeErrorListeners();
  lexer.addErrorListener(errors);
  const tokens = new CommonTokenStream(lexer);
  const parser = makeParser(tokens);
  parser.removeErrorListeners();
  parser.interpreter.predictionMode = PredictionMode.SLL;
  parser.errorHandler = new BailErrorStrategy();
  try {
    return { tree: entry(parser), errors: errors.count };
  } catch {
    tokens.seek(0);
    parser.reset();
    parser.errorHandler = new DefaultErrorStrategy();
    parser.interpreter.predictionMode = PredictionMode.LL;
  }
  parser.addErrorListener(errors);
  const tree = entry(parser);
  return { tree, errors: errors.count };
}
