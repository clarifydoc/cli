import { describe, expect, it } from "vitest";
import { GoLexer } from "./go/GoLexer.js";
import { GoParser } from "./go/GoParser.js";
import { parseWithAntlr } from "./run.js";

const SOURCE = `package league

func Play(table map[string]int, goals chan int, club *Club) {
	a, b := score(club.Name, table["home"]), 2
	table[club.Name] = <-goals
	table[club.Name] += len([]int{1, 2}[0:1])
	club.Wins++
	goals <- a + b
	<-goals
	score(club.Name, func() int { return 1 }())
	if n := club.Total(); n > 0 {
		club.Wins--
	}
	for i := 0; i < 3; i++ {
		club.Pay(Player{Name: "x"})
	}
	switch s := club.Kind().(type) {
	case int:
		_ = s
	}
	Club{}.Reset()
	func() { a = 3 }()
}
`;

describe("Go simple statements settled from tokens", () => {
  it("reads the same tree as prediction", () => {
    const read = (settle: boolean) => {
      let parser!: GoParser;
      const { tree, errors } = parseWithAntlr(
        SOURCE,
        (input) => new GoLexer(input),
        (tokens) => {
          parser = new GoParser(tokens);
          if (settle) parser.settleStatements();
          return parser;
        },
        (p) => p.sourceFile(),
      );
      return { text: tree.toStringTree(parser), errors };
    };
    const settled = read(true);
    expect(settled.errors).toBe(0);
    expect(settled).toEqual(read(false));
  });
});
