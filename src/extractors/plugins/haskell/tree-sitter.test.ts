import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { loadHaskellReader } from "./tree-sitter.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ParsedStructure } from "../../../types/language-plugin.js";

let readHaskell: (source: string) => ParsedStructure;
beforeAll(async () => {
  readHaskell = await loadHaskellReader();
});

const CLUBS = `module League.Clubs where

import qualified League.Standings as Standings

findClub :: Db -> Int -> IO (Maybe Club)
findClub db cid = do
  rows <- query db "select * from clubs where id = ?" (Only cid)
  pure (listToMaybe rows)
findClub _ 0 = return Nothing

rankClubs clubs = Standings.rank season table \`orElse\` fallback clubs
  where fallback cs = sortOn points cs

instance Show Club where
  show c = renderClub c
`;

describe("Haskell through tree-sitter", () => {
  it("reads a signature and its equations as one function, a definition without a signature, and an instance method", () => {
    const parsed = readHaskell(CLUBS);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["findClub", 5, 9],
      ["rankClubs", 11, 12],
      ["Club.show", 15, 15],
    ]);
  });

  it("names applications without parentheses, qualified names and infix names; a where definition's calls are its owner's", () => {
    const calls = (name: string) => readHaskell(CLUBS).functions.find((f) => f.name === name)!.calls.map((c) => c.name);
    // Data constructors (`Only`, `Nothing`) are no calls; `return` is a keyword to the recorder.
    expect(calls("findClub")).toEqual(["query", "pure", "listToMaybe"]);
    expect(calls("rankClubs")).toEqual(["Standings.rank", "orElse", "fallback", "sortOn"]);
  });

  it("names no type in a signature (real-repo FP)", () => {
    const parsed = readHaskell("handler :: HandlerT Site (HandlerT master IO) Html\nhandler = render page\n");
    expect(parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["handler", ["render"]]]);
  });

  it("names an instance's methods by its type and a class's defaults by the class, never by their bare names", () => {
    const parsed = readHaskell("instance ToJSON Club where\n  toJSON c = object [clubName c]\n\ninstance Show (Fixture a) where\n  show f = renderFixture f\n\nclass Ranked a where\n  rank :: a -> Int\n  rank _ = defaultRank 0\n");
    expect(parsed.functions.map((f) => [f.name, f.line, f.calls.map((c) => c.name)])).toEqual([
      ["Club.toJSON", 2, ["object", "clubName"]],
      ["Fixture.show", 5, ["renderFixture"]],
      ["Ranked.rank", 8, ["defaultRank"]],
    ]);
  });

  it("starts a function at its first signature across CPP lines", () => {
    const parsed = readHaskell("module A where\n#if MIN_VERSION_base(4,0,0)\nserve :: Int -> IO ()\n#else\nserve :: Int -> IO Int\n#endif\nserve n = run n\n");
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([["serve", 3, 7]]);
  });

  it("counts the errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readHaskell("f x = (x\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`. Haskell applies a function without parentheses;
 * the patterns read only `f (x)`, and end a function at its signature when the equations follow at the same indent.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  "test-fixtures/sample-haskell-app/src/Main.hs": {
    getPlayer: [[], ["pure", "T.pack"]],
    renderPlayer: [[], ["playerName"]],
    main: [[], ["putStrLn"]],
  },
};

describe("Haskell: tree-sitter and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.hs", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readHaskell(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => a.functions.map((f) => ({ name: f.name, line: f.line, calls: f.calls.map((c) => c.name) }));
      const regex = shape(extractWithRegex(src, rel, "haskell"));
      const tree = shape(extractWithRegex(src, rel, "haskell", undefined, parsed));
      expect(tree.map(({ calls: _, ...fn }) => fn)).toEqual(regex.map(({ calls: _, ...fn }) => fn));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = tree[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
