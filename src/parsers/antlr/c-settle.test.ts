import { describe, expect, it } from "vitest";
import { CLexer } from "./c/CLexer.js";
import { CParser } from "./c/CParser.js";
import { parseWithAntlr } from "./run.js";

/** Reads `source` as the C reader does (a file with an error is not read), with the settled decisions on or off. */
function read(source: string, settle: boolean, full = true): { text: string | null; errors: number } {
  let parser!: CParser;
  const { tree, errors } = parseWithAntlr(
    source,
    (input) => new CLexer(input),
    (tokens) => {
      parser = new CParser(tokens);
      parser.prepare(tokens, settle, full);
      return parser;
    },
    (p) => p.compilationUnit(),
    { firstError: true },
  );
  return { text: tree ? tree.toStringTree(parser) : null, errors };
}

function same(source: string): void {
  const settled = read(source, true);
  expect(settled.errors).toBe(0);
  expect(settled.text).not.toBeNull();
  expect(settled).toEqual(read(source, false));
  // Settled in the SLL pass only, as before the full-context pass was settled too.
  expect(settled).toEqual(read(source, true, false));
}

const STATEMENTS = `
typedef struct club { int rank; } club_t;
typedef int goals_t;

static void play(club_t *home, club_t *away, goals_t goals)
{
	goals_t total = 0, extra;
	club_t *winner;
	score(home, goals);
	total = total + goals;
	home->rank++;
	(void)away;
	if (goals > 0) record(home); else record(away);
	while (total < 3) { total++; }
	do { total--; } while (total > 0);
	for (extra = 0; extra < 2; extra++) bump(home);
	switch (goals) {
	case 1: record(home); break;
	default: record(away);
	}
kickoff:
	if (total) goto kickoff;
retry: while (extra) extra--;
done:
	{ record(winner); }
final: ;
	return;
}
`;

const MACROS = `
#define LEAGUE_ENTRY(x)
LEAGUE_ENTRY(alpha)
LEAGUE_ENTRY(beta)
LEAGUE_ENTRY(gamma);
LEAGUE_ENTRY(delta) static int served;

typedef struct car { int speed; } car_t;

void drive(car_t *c)
{
	VERBOSE(car_t laps = 0);
	FOR_EACH_CAR(c, i) { i->speed++; }
	REPORT(c) log_speed(c);
	LEAGUE_STEP(1)
	LEAGUE_STEP(2)
	car_t *next = c;
	car_t extra;
	ALIGNED(8) int aligned_laps;
	log_speed(next);
	not_a_type * next;
}

MATCH_TEST(kickoff) { check(1); }
PARSER_PRAGMA
int __attribute__((unused)) quiet(void);
extern int garage_bays(void), garage_spots(int n);
struct garage { int bays; } pit = { 4 };
int table[3] = { 1, 2, 3 };
`;

describe("C decisions settled from tokens", () => {
  it("reads statements, labels and declarations as prediction does", () => same(STATEMENTS));
  it("reads statement and file-scope macros as prediction does", () => same(MACROS));
  it("leaves a file with an error to the full-context pass, both ways", () => {
    const broken = "void f(void) { x = ; }\n";
    expect(read(broken, true)).toEqual(read(broken, false));
    expect(read(broken, true).text).toBeNull();
    expect(read(broken, true, false)).toEqual(read(broken, true));
  });
});
