import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseUnifiedHunks, symbolsInHunks } from "./changed-symbols.js";

const fn = (name: string, line: number, endLine: number) => ({ name, line, endLine });

// A real `git diff -U0`: a whole function deleted between two others.
describe("a deletion-only hunk", () => {
  const source = [
    "export function kickOff() {", //            1
    "  return 1;", //                            2
    "}", //                                       3
    "export function substitute() {", //         4
    "  return 2;", //                            5
    "}", //                                       6
    "export function fullTime() {", //           7
    "  return 3;", //                            8
    "}", //                                       9
    "",
  ];
  const analysis = { functions: [fn("kickOff", 1, 3), fn("substitute", 4, 6), fn("fullTime", 7, 9)], classes: [] } as never;
  const gitDiff = (after: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "del-hunk-"));
    try {
      const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir, encoding: "utf8" });
      g("init", "-q");
      writeFileSync(join(dir, "match.ts"), source.join("\n"));
      g("add", "match.ts");
      g("commit", "-q", "-m", "base");
      writeFileSync(join(dir, "match.ts"), after.join("\n"));
      return g("diff", "-U0", "--no-color");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("charges the function that held the lines, not the one above", () => {
    const diff = gitDiff([...source.slice(0, 3), ...source.slice(6)]);
    const found = symbolsInHunks(new Map([["match.ts", analysis]]), parseUnifiedHunks(diff));
    expect(found.symbols.map((s) => s.symbol)).toEqual(["substitute"]);
    expect(found.moduleLevel).toEqual([]);
  });

  it("charges the function a few lines were deleted from, and keeps other hunks as they were", () => {
    const diff = gitDiff([...source.slice(0, 4), ...source.slice(5, 8), "  return 33;", ...source.slice(8)]);
    const found = symbolsInHunks(new Map([["match.ts", analysis]]), parseUnifiedHunks(diff));
    expect(found.symbols.map((s) => s.symbol)).toEqual(["substitute", "fullTime"]);
  });

  it("deleting lines outside every function is module level", () => {
    const hunks = parseUnifiedHunks("--- a/match.ts\n+++ b/match.ts\n@@ -12,2 +11,0 @@\n");
    const found = symbolsInHunks(new Map([["match.ts", analysis]]), hunks);
    expect(found.symbols).toEqual([]);
    expect(found.moduleLevel).toEqual(["match.ts"]);
  });
});
