import { describe, expect, it } from "vitest";
import { RustLexer } from "./rust/RustLexer.js";
import { RustParser } from "./rust/RustParser.js";
import { RustReadLexer } from "./rust/RustReadLexer.js";
import { parseSll } from "./run.js";

const SOURCE = `
fn play(club: &Club, table: Vec<Club>) -> u32 {
    let total = if club.wins() > 2 { club.goals() } else if club.draws() > 1 { 1 } else { 0 };
    let kept = if club.wins() > 2 { 1 } else { 2 } else { return 0 };
    if club.ready() { club.reset(); }
    let names = table.iter().map(|c| c.name()).collect::<Vec<_>>();
    let sum = 1 + club.wins().max(2) * club.goals().min(3);
    #[cfg(feature = "x")]
    club.log();
    let attributed = (#[allow(unused)] club.name()).len();
    (club.field)(3);
    club.stadium.open(1).close(2).await?;
    match club.kind() { Kind::A => club.a(), Kind::B => club.b() }.run();
    -club.score().abs();
    loop { club.tick(); break; }
    r#loop.r#match(1);
    total + kept
}
`;

describe("Rust expression decisions settled from tokens", () => {
  it.each([
    ["read lexer", (input: any) => new RustReadLexer(input)],
    ["plain lexer", (input: any) => new RustLexer(input)],
  ])("reads the same tree as prediction (%s)", (_name, lexer) => {
    const read = (settle: boolean) => {
      let parser!: RustParser;
      const parsed = parseSll(
        SOURCE,
        lexer,
        (tokens) => {
          parser = new RustParser(tokens);
          if (settle) parser.settleExpressions();
          return parser;
        },
        (p) => p.crate(),
      );
      return parsed ? parsed.tree.toStringTree(parser) : null;
    };
    const settled = read(true);
    expect(settled).not.toBeNull();
    expect(settled).toEqual(read(false));
  });
});
