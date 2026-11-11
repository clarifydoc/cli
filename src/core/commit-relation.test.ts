import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitRelation, describeCommitRelation, headCommit } from "./source-revision.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Coach", "-c", "user.email=coach@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

describe("commitRelation", () => {
  let dir: string;
  let first: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relation-"));
    run(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "club.ts"), "export const club = 1;\n");
    run(dir, "add", "club.ts");
    run(dir, "commit", "-q", "-m", "club");
    first = run(dir, "rev-parse", "HEAD");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("says nothing outside a repository, and current at the same commit", async () => {
    const plain = mkdtempSync(join(tmpdir(), "relation-plain-"));
    try {
      expect(await commitRelation(plain, first)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(await commitRelation(dir, first)).toEqual({ state: "current" });
    expect(describeCommitRelation({ state: "current" })).toBeNull();
  });

  it("counts commits behind, then older, diverged and missing", async () => {
    for (const n of [2, 3]) {
      writeFileSync(join(dir, "club.ts"), `export const club = ${n};\n`);
      run(dir, "commit", "-q", "-am", `club ${n}`);
    }
    const tip = (await headCommit(dir))!;
    expect(await commitRelation(dir, first)).toEqual({ state: "behind", behind: 2 });
    expect(describeCommitRelation({ state: "behind", behind: 1 })).toBe("HEAD is 1 commit ahead of the analyzed commit");

    run(dir, "checkout", "-q", first);
    expect(await commitRelation(dir, tip)).toEqual({ state: "older", ahead: 2 });

    run(dir, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "garage.ts"), "export const garage = 1;\n");
    run(dir, "add", "garage.ts");
    run(dir, "commit", "-q", "-m", "garage");
    expect(await commitRelation(dir, tip)).toEqual({ state: "diverged", ahead: 2, behind: 1 });

    expect(await commitRelation(dir, "0123456789abcdef0123456789abcdef01234567")).toEqual({ state: "missing" });
    expect(await commitRelation(dir, "not-a-commit")).toBeNull();
  });
});
