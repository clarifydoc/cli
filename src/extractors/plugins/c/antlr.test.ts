import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { readC } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";

const shape = (source: string) => {
  const parsed = readC(source);
  return { errors: parsed.syntaxErrors, functions: parsed.functions.map((f) => [f.name, f.line, f.endLine, f.calls.map((c) => c.name)]) };
};

describe("C through ANTLR", () => {
  it("reads types no header declares from how the file uses them", () => {
    const source = `static club_t *find_club(league_t *league, int id) {
  squad_t squad = league->squads[id];
  player_t *captain = (player_t *) pick(squad, 0);
  return lookup(league->clubs, captain->club_id);
}
`;
    expect(shape(source)).toEqual({ errors: 0, functions: [["find_club", 1, 5, ["pick", "lookup"]]] });
  });

  it("names calls as the patterns do: a member path, a member after -> alone", () => {
    const source = "void kickoff(struct match *m) {\n  m->ops->whistle(m);\n  m->ref.signal(1);\n  start(m);\n}\n";
    expect(shape(source).functions).toEqual([["kickoff", 1, 5, ["whistle", "ref.signal", "start"]]]);
  });

  it("reads a loop macro as a call of the function around it, never a function of its own (real-repo FP)", () => {
    const source = "void rate_squad(struct squad *s) {\n  struct player *p;\n  for_each_player(p, s) {\n    rate(p);\n  }\n}\n";
    expect(shape(source).functions).toEqual([["rate_squad", 1, 6, ["for_each_player", "rate"]]]);
  });

  it("names the calls in a macro's arguments and in its block argument", () => {
    const source = `void check_goals(struct match *m) {
  expect_cond("goals", count_goals(m) > 0)
  for_each_car(garage, {
    wash(car);
  });
  close_match(m);
}
`;
    expect(shape(source).functions).toEqual([["check_goals", 1, 7, ["expect_cond", "count_goals", "for_each_car", "wash", "close_match"]]]);
  });

  it("reads a statement macro before a call as no declaration of it (real-repo FP)", () => {
    const source = "void service(struct car *car) {\n  IGNORE_DEPRECATION(\n    old_setup(car);\n  )\n  start_engine(car);\n}\n";
    expect(shape(source).functions).toEqual([["service", 1, 6, ["IGNORE_DEPRECATION", "old_setup", "start_engine"]]]);
  });

  it("counts the calls of a #define written inside a function", () => {
    const source = "void race(struct car *car) {\n#define LAP(n) \\\n  total += lap_time(car, n)\n  LAP(1);\n}\n";
    expect(shape(source).functions).toEqual([["race", 1, 5, ["lap_time", "LAP"]]]);
  });

  it("leaves out code no compiler sees", () => {
    const source = "#ifdef __cplusplus\nextern \"C\" {\n#endif\nint score(void) {\n#if 0\n  legacy_score();\n#endif\n  return tally();\n}\n";
    expect(shape(source).functions).toEqual([["score", 4, 9, ["tally"]]]);
  });

  it("reads one function where each platform writes its header, and what the other branches define and call", () => {
    const source = `#if defined(_WIN32)
int start_engine(HANDLE ignition) {
#else
int start_engine(int ignition) {
#endif
#if defined(_WIN32)
  return win_start(ignition);
#else
  return posix_start(ignition);
#endif
}
#ifdef _WIN32
static int wake_pit(void) { return pipe_wake(); }
#else
static int wake_pit(void) { return eventfd_wake(); }
static int open_pit(void) { return pit_open(); }
#endif
`;
    expect(shape(source)).toEqual({
      errors: 0,
      functions: [
        ["start_engine", 2, 11, ["win_start", "posix_start"]],
        ["wake_pit", 13, 13, ["pipe_wake"]],
        ["wake_pit", 15, 15, ["eventfd_wake"]],
        ["open_pit", 16, 16, ["pit_open"]],
      ],
    });
  });

  it("counts a syntax error and reads nothing more of the file, so core keeps the patterns' reading", () => {
    expect(shape("int f(void) { return (1; }\n")).toEqual({ errors: 1, functions: [] });
  });
});

describe("C: ANTLR and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  // Headers are the C++ plugin's.
  const files = globSync("test-fixtures/**/*.c", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readC(src);
      expect(parsed.syntaxErrors).toBe(0);
      const read = (a: ReturnType<typeof extractWithRegex>) => a.functions.map((f) => ({ name: f.name, line: f.line, calls: f.calls.map((c) => c.name) }));
      expect(read(extractWithRegex(src, rel, "c", undefined, parsed))).toEqual(read(extractWithRegex(src, rel, "c")));
    });
  }
});
