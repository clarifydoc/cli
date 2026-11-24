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

/** Operands, composite literals against blocks, conversions and keyed elements: the forms the operand decisions settle. */
const OPERANDS = `package league

type Box[T any] struct{ v T }

func Run(items []Club, ok bool, cases map[string]Club, n int) {
	a := Club{Name: "x", Rank: 1}
	b := &league.Club{Name: "y"}
	c := Box[Club]{v: a}
	d := []Club{{Name: "p"}, {Name: "q"}}
	e := map[string][]Club{"k": {a}, "j": nil}
	f := []struct{ N int }{{1}, {2}}
	g := []byte("abc")
	h := [3]int{1, 2, 3}
	i := (*Club)(nil)
	j := items[n]
	k := Box[Club]{}.v
	if ok {
		print(a)
	}
	if ok { print(b) }
	if league.IsOpen {
		print(c)
	} else if items[0].Name == "z" {
		print(d)
	}
	if x := (Club{Name: "w"}); x.Rank > 0 && ok {
		print(e, f, g, h, i, j, k)
	}
	if reflect.DeepEqual(a, Club{Name: "x"}) {
		print(a)
	}
	for _, club := range items {
		print(club)
	}
	for _, club := range cases {
		print(club)
	}
	for range []Club{a, b2} {
		print(1)
	}
	switch n {
	case 1:
		print(1)
	}
	switch club := items[0]; club.Rank {
	case 2:
		print(2)
	}
	for ok {
		ok = !ok
	}
	_ = func() Club { return Club{Name: "fn"} }()
	go func(c Club) { print(c) }(Club{})
	print(map[string]int{"a": 1}["a"], []int{1, 2}[0], len([]string{"s"}))
}
`;

describe("Go simple statements settled from tokens", () => {
  it("reads the same tree as prediction", () => {
    const read = (settle: boolean, source = SOURCE) => {
      let parser!: GoParser;
      const { tree, errors } = parseWithAntlr(
        source,
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

  it("reads operands and literals as prediction does", () => {
    const read = (settle: boolean) => {
      let parser!: GoParser;
      const { tree, errors } = parseWithAntlr(
        OPERANDS,
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

  it("reads a block after a name in a header as a block", () => {
    const source = "package league\nfunc Run(ok bool) {\n\tif ok { Play() }\n\tfor ok { Play() }\n}\n";
    let parser!: GoParser;
    const { tree, errors } = parseWithAntlr(
      source,
      (input) => new GoLexer(input),
      (tokens) => {
        parser = new GoParser(tokens);
        parser.settleStatements();
        return parser;
      },
      (p) => p.sourceFile(),
    );
    expect(errors).toBe(0);
    expect(tree.toStringTree(parser)).not.toContain("compositeLit");
  });
});
