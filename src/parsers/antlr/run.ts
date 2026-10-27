import {
  BailErrorStrategy,
  BaseErrorListener,
  CharStream,
  CommonTokenStream,
  DefaultErrorStrategy,
  ParseCancellationException,
  PredictionMode,
  type Lexer,
  type Parser,
  type ParserRuleContext,
} from "antlr4ng";

import { normalizeSource } from "../normalize-source.js";

export { normalizeSource };

/** The full-context pass's time budget: a base, and a share per character of the source (20 ms per KB). */
const LL_BUDGET_MS = 250;
const LL_CHARS_PER_MS = 50;

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

/** A parse that stops at its first error: no tree then, and the errors seen up to it. */
export interface AntlrCheck<T extends ParserRuleContext> {
  tree: T | null;
  errors: number;
}

/**
 * Parses `source` with a generated lexer and parser, starting at `entry`: first with SLL prediction and a
 * parser that gives up at the first error — the fast path, exact whenever it succeeds — and again with full
 * LL only when that fails, which is what reports the errors. With `firstError`, the LL pass gives up at its
 * first error too, for a reader whose file is not read at all once it has one: error recovery is where a
 * full-context parse spends seconds on a file that will not be used — and gives up past a time budget.
 */
export function parseWithAntlr<P extends Parser, T extends ParserRuleContext>(
  source: string,
  makeLexer: (input: CharStream) => Lexer,
  makeParser: (tokens: CommonTokenStream) => P,
  entry: (parser: P) => T,
): AntlrParse<T>;
export function parseWithAntlr<P extends Parser, T extends ParserRuleContext>(
  source: string,
  makeLexer: (input: CharStream) => Lexer,
  makeParser: (tokens: CommonTokenStream) => P,
  entry: (parser: P) => T,
  options: { firstError: true },
): AntlrCheck<T>;
export function parseWithAntlr<P extends Parser, T extends ParserRuleContext>(
  source: string,
  makeLexer: (input: CharStream) => Lexer,
  makeParser: (tokens: CommonTokenStream) => P,
  entry: (parser: P) => T,
  options?: { firstError: true },
): AntlrCheck<T> {
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
    parser.interpreter.predictionMode = PredictionMode.LL;
  }
  if (options?.firstError) {
    // Full-context prediction can take seconds where a grammar is ambiguous; a file that needs more than a budget
    // several times a normal parse's is read as having an error.
    const simulator = parser.interpreter;
    const predict = simulator.adaptivePredict;
    const deadline = performance.now() + LL_BUDGET_MS + source.length / LL_CHARS_PER_MS;
    simulator.adaptivePredict = (input, decision, outer) => {
      if (performance.now() > deadline) throw new ParseCancellationException(new Error("full-context prediction over budget"));
      return predict.call(simulator, input, decision, outer);
    };
    try {
      return { tree: entry(parser), errors: errors.count };
    } catch {
      return { tree: null, errors: errors.count + 1 };
    } finally {
      simulator.adaptivePredict = predict;
    }
  }
  parser.errorHandler = new DefaultErrorStrategy();
  parser.addErrorListener(errors);
  const tree = entry(parser);
  return { tree, errors: errors.count };
}
