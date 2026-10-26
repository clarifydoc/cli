import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const names = (src: string, file: string, lang: "c" | "cpp") => {
  const a = extractWithRegex(src, file, lang);
  return [...a.functions.map((f) => f.name), ...a.classes.flatMap((c) => c.methods.map((m) => `${c.name}.${m.name}`))].sort();
};
const fnOf = (src: string, file: string, lang: "c" | "cpp", name: string) => {
  const a = extractWithRegex(src, file, lang);
  return [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name)!;
};

describe("C and C++ definitions whose body opens on a later line", () => {
  it("reads a C definition with wrapped parameters or an Allman brace, never a prototype", () => {
    const src = [
      "static int scoreMatch(struct club *home,", // 1
      "                      struct club *away)", // 2
      "{", // 3
      "    return tally(home, away);", // 4
      "}", // 5
      "int kickOff(void);", // 6
      "void", // 7
      "whistle(int minute)", // 8
      "{", // 9
      '    shout("{");', // 10
      "}", // 11
    ].join("\n");
    expect(names(src, "league.c", "c")).toEqual(["scoreMatch", "whistle"]);
    expect(fnOf(src, "league.c", "c", "scoreMatch").endLine).toBe(5);
    expect(fnOf(src, "league.c", "c", "scoreMatch").calls.map((c) => c.name)).toContain("tally");
    expect(fnOf(src, "league.c", "c", "whistle").endLine).toBe(11);
  });

  it("reads Allman C++ methods and out-of-line definitions, not initializers, branches or strings", () => {
    const src = [
      "class Club : public Base", // 1
      "{", // 2
      "  public:", // 3
      "    Club(int id)", // 4
      "        : Base(id),", // 5
      "          roster_(id)", // 6
      "    {", // 7
      "    }", // 8
      "    std::optional<int> captain() const", // 9
      "    {", // 10
      "        if constexpr (true)", // 11
      "        {", // 12
      "        }", // 13
      '        report("half: time");', // 14
      "        return pick();", // 15
      "    }", // 16
      "};", // 17
      "const std::string &league::Club::name() const noexcept", // 18
      "{", // 19
      '    auto sql = R"sql(SELECT { FROM clubs)sql";', // 20
      "    return lookup(sql);", // 21
      "}", // 22
    ].join("\n");
    expect(names(src, "club.cc", "cpp")).toEqual(["Club.Club", "Club.captain", "Club.name"]);
    expect(fnOf(src, "club.cc", "cpp", "name").endLine).toBe(22);
    expect(fnOf(src, "club.cc", "cpp", "name").calls.map((c) => c.name)).toContain("lookup");
  });
});
