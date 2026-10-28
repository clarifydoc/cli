import { describe, it, expect } from "vitest";
import { CommonTokenStream, CharStream } from "antlr4ng";
import { CLexer } from "./c/CLexer.js";
import { CParser } from "./c/CParser.js";
import { boundPredictionCache } from "./run.js";
import { readC } from "../../extractors/plugins/c/antlr.js";

const SOURCE = `
static int score(struct match *m) { return m->home - m->away; }
int table(struct league *l) {
  for (int i = 0; i < l->count; i++) { if (score(&l->matches[i]) > 0) promote(l, i); }
  return relegate(l);
}
`;

/** A parser of the grammar, its prediction cache warmed by one parse. */
function warmParser(): CParser {
  const tokens = new CommonTokenStream(new CLexer(CharStream.fromString(SOURCE)));
  const parser = new CParser(tokens);
  parser.prepare(tokens);
  parser.removeErrorListeners();
  parser.compilationUnit();
  return parser;
}

const cachedStates = (parser: CParser): number => parser.interpreter.decisionToDFA.reduce((n, dfa) => n + dfa.length, 0);

describe("boundPredictionCache", () => {
  it("leaves a cache under the bound alone", () => {
    const parser = warmParser();
    const before = cachedStates(parser);
    expect(before).toBeGreaterThan(0);
    boundPredictionCache(parser, before);
    expect(cachedStates(parser)).toBe(before);
  });

  it("empties a cache past the bound, and the next reading is the same", () => {
    const warm = readC(SOURCE);
    const parser = warmParser();
    boundPredictionCache(parser, 0);
    expect(cachedStates(parser)).toBe(0);
    expect(readC(SOURCE)).toEqual(warm);
  });
});
