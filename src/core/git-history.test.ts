import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectGitHistory, computeHotspots, isFixCommit } from "./git-history.js";
import type { FileChurnInfo, FileComplexityInfo } from "../types/analysis.js";

/**
 * The collector tests build a real throwaway repo — git behavior (numstat
 * format, --show-prefix, shallow detection) is exactly what's under test, so
 * mocking it would test nothing.
 */

let root: string;
const repo = () => join(root, "repo");

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...env,
    },
    stdio: "pipe",
  });

const commit = (msg: string, author: string, dateIso?: string) =>
  git(repo(), ["commit", "-m", msg, "--author", `${author} <t@t>`], {
    ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}),
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rvd-git-history-"));
  mkdirSync(repo(), { recursive: true });
  git(repo(), ["init", "-q"]);
  git(repo(), ["config", "user.name", "t"]);
  git(repo(), ["config", "user.email", "t@t"]);

  // Commit 1 (alice): a.ts + sub/b.ts
  writeFileSync(join(repo(), "a.ts"), "line1\nline2\n");
  mkdirSync(join(repo(), "sub"), { recursive: true });
  writeFileSync(join(repo(), "sub", "b.ts"), "b\n");
  git(repo(), ["add", "-A"]);
  commit("init", "alice");

  // Commit 2 (bob): touch a.ts
  writeFileSync(join(repo(), "a.ts"), "line1\nline2\nline3\n");
  git(repo(), ["add", "-A"]);
  commit("second", "bob");

  // Commit 3 (alice): touch a.ts again + add doomed.ts
  writeFileSync(join(repo(), "a.ts"), "line1\n");
  writeFileSync(join(repo(), "doomed.ts"), "x\n");
  git(repo(), ["add", "-A"]);
  commit("third", "alice");

  // Commit 4 (alice): delete doomed.ts — it must not appear in churn.
  git(repo(), ["rm", "-q", "doomed.ts"]);
  commit("delete", "alice");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows can hold git handles briefly — temp dir, best effort. */
  }
});

describe("collectGitHistory", () => {
  it("aggregates commits, line deltas, recency and authors per current file", async () => {
    const res = await collectGitHistory(repo(), ["a.ts", "sub/b.ts"]);
    expect("churn" in res).toBe(true);
    const { churn, commitCount } = res as { churn: FileChurnInfo[]; commitCount: number };
    expect(commitCount).toBe(4);

    const a = churn.find((c) => c.file === "a.ts")!;
    expect(a.commits).toBe(3);
    expect(a.additions).toBe(3); // +2 (init) +1 (line3) +0 (shrink)
    expect(a.deletions).toBe(2); // −0 −0 −2
    expect(a.authors[0]).toBe("alice"); // 2 commits vs bob's 1
    expect(a.authorCount).toBe(2);
    expect(a.lastTouched).toBeTruthy();

    const b = churn.find((c) => c.file === "sub/b.ts")!;
    expect(b.commits).toBe(1);

    // Deleted files never make it into churn.
    expect(churn.some((c) => c.file === "doomed.ts")).toBe(false);
    // Most-churned first.
    expect(churn[0]!.file).toBe("a.ts");
  });

  it("matches current-tree paths case-insensitively", async () => {
    const res = await collectGitHistory(repo(), ["A.TS"]);
    const { churn } = res as { churn: FileChurnInfo[] };
    expect(churn).toHaveLength(1);
    expect(churn[0]!.file).toBe("A.TS"); // caller's canonical casing wins
  });

  it("strips the --show-prefix when the analyzed root is a repo subdirectory", async () => {
    const res = await collectGitHistory(join(repo(), "sub"), ["b.ts"]);
    const { churn } = res as { churn: FileChurnInfo[] };
    expect(churn).toHaveLength(1);
    expect(churn[0]!.file).toBe("b.ts");
  });

  it("excludes commits older than the window", async () => {
    // An ancient commit outside a 1-month window on a fresh file.
    writeFileSync(join(repo(), "old.ts"), "old\n");
    git(repo(), ["add", "-A"]);
    commit("ancient", "carol", "2020-01-01T12:00:00");

    // The window ends at HEAD's date: a recent commit after the ancient one.
    writeFileSync(join(repo(), "sub", "b.ts"), "b2\n");
    git(repo(), ["add", "-A"]);
    commit("recent", "bob");
    const res = await collectGitHistory(repo(), ["old.ts"], { months: 1 });
    const { churn } = res as { churn: FileChurnInfo[] };
    expect(churn.some((c) => c.file === "old.ts")).toBe(false);
  });

  it("skips non-repos", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const res = await collectGitHistory(plain, ["x.ts"]);
    expect(res).toEqual({ skipped: "not a git repository" });
  });

  it("skips shallow clones", async () => {
    const shallow = join(root, "shallow");
    git(root, ["clone", "-q", "--depth", "1", `file://${repo().replace(/\\/g, "/")}`, shallow]);
    const res = await collectGitHistory(shallow, ["a.ts"]);
    expect("skipped" in res && /shallow/.test((res as { skipped: string }).skipped)).toBe(true);
  });

  it("skips when the git binary is missing", async () => {
    const res = await collectGitHistory(repo(), ["a.ts"], { gitBin: "definitely-not-git-xyz" });
    expect("skipped" in res).toBe(true);
  });
});

describe("computeHotspots", () => {
  const churnOf = (file: string, commits: number): FileChurnInfo => ({
    file, commits, additions: 0, deletions: 0, lastTouched: "", authors: [], authorCount: 1,
  });
  const cxOf = (filePath: string, totalComplexity: number): FileComplexityInfo => ({
    filePath, totalComplexity, maxComplexity: totalComplexity, averageComplexity: totalComplexity, functions: [],
  });

  it("multiplies normalized churn by normalized complexity", () => {
    const hs = computeHotspots(
      [churnOf("hot.ts", 10), churnOf("warm.ts", 5), churnOf("cold.ts", 1)],
      [cxOf("hot.ts", 100), cxOf("warm.ts", 100), cxOf("cold.ts", 1)],
    );
    expect(hs[0]).toEqual({ file: "hot.ts", score: 1, commits: 10, totalComplexity: 100 });
    expect(hs[1]!.file).toBe("warm.ts");
    expect(hs[1]!.score).toBe(0.5);
    expect(hs[2]!.score).toBeCloseTo(0.001, 3);
  });

  it("requires BOTH signals — churned-but-trivial and complex-but-static files drop out", () => {
    const hs = computeHotspots(
      [churnOf("readme-ish.ts", 50)],
      [cxOf("static-beast.ts", 500)],
    );
    expect(hs).toEqual([]);
  });

  it("joins case-insensitively and caps at top N", () => {
    const churn = Array.from({ length: 60 }, (_, i) => churnOf(`f${i}.ts`, i + 1));
    const cx = Array.from({ length: 60 }, (_, i) => cxOf(`F${i}.TS`, 10));
    const hs = computeHotspots(churn, cx, 50);
    expect(hs).toHaveLength(50);
    expect(hs[0]!.file).toBe("f59.ts");
  });
});

describe("collectGitHistory — renames, ownership, co-change", () => {
  let dir: string;
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_EMAIL: "x@x", ...env } });
  const save = (msg: string, author: string) => { run(["add", "-A"]); run(["commit", "-q", "-m", msg, "--author", `${author} <${author}@x>`]); };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rvd-git-cochange-"));
    run(["init", "-q"]);
    run(["config", "user.name", "t"]);
    run(["config", "user.email", "t@t"]);
    writeFileSync(join(dir, "api.ts"), "a1\n");
    writeFileSync(join(dir, "client.ts"), "c1\n");
    writeFileSync(join(dir, "old-name.ts"), "o1\nshared body that git can follow\nline three\nline four\n");
    save("one", "ann");
    for (let i = 2; i <= 4; i++) {
      writeFileSync(join(dir, "api.ts"), `a${i}\n`);
      writeFileSync(join(dir, "client.ts"), `c${i}\n`);
      save(`pair ${i}`, i === 4 ? "ben" : "ann");
    }
    run(["mv", "old-name.ts", "new-name.ts"]);
    save("rename", "ann");
    writeFileSync(join(dir, "new-name.ts"), "o2\nshared body that git can follow\nline three\nline four\n");
    save("edit after rename", "ann");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("follows a rename, shares and bus factor, and pairs files committed together", async () => {
    const res = await collectGitHistory(dir, ["api.ts", "client.ts", "new-name.ts"]);
    const { churn, coChange } = res as { churn: FileChurnInfo[]; coChange: Array<{ a: string; b: string; count: number; score: number }> };
    // The commit before the rename counts for the file's current name.
    expect(churn.find((c) => c.file === "new-name.ts")!.commits).toBe(3);
    const api = churn.find((c) => c.file === "api.ts")!;
    expect(api.authorShares).toEqual([{ name: "ann", commits: 3 }, { name: "ben", commits: 1 }]);
    expect(api.busFactor).toBe(1);
    expect(coChange).toEqual([{ a: "api.ts", b: "client.ts", count: 4, score: 1 }]);
  });
});

describe("isFixCommit", () => {
  it("reads conventional fixes, reverts and issue-closing subjects", () => {
    for (const s of ["fix: null check", "fix(api)!: drop field", "bugfix: x", "Hotfix: y", 'Revert "feat: z"', "Fixes #12 in parser", "closes and fixed #9", "Fix crash on empty list"]) {
      expect(isFixCommit(s), s).toBe(true);
    }
    for (const s of ["feat: prefix fixture", "fixture data", "refactor: prefix", "add fix-ups doc", "suffix: nothing"]) {
      expect(isFixCommit(s), s).toBe(false);
    }
  });

  it("counts a file's fix commits and the newest one's date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rvd-git-fixes-"));
    try {
      git(dir, ["init", "-q"]);
      const step = (file: string, body: string, msg: string, date: string) => {
        writeFileSync(join(dir, file), body);
        git(dir, ["add", file]);
        git(dir, ["commit", "-q", "-m", msg, "--author", "a <t@t>"], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_COMMITTER_NAME: "a", GIT_AUTHOR_NAME: "a" });
      };
      const now = Date.now();
      const d = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
      step("p.ts", "1\n", "feat: parser", d(5));
      step("p.ts", "2\n", "fix: off by one", d(4));
      step("q.ts", "1\n", "feat: q", d(3));
      step("p.ts", "3\n", "fix(parser): empty input", d(2));
      const res = (await collectGitHistory(dir, ["p.ts", "q.ts"])) as { churn: FileChurnInfo[] };
      const p = res.churn.find((c) => c.file === "p.ts")!;
      expect(p.fixes).toBe(2);
      expect(p.lastFix!.slice(0, 10)).toBe(d(2).slice(0, 10));
      expect(res.churn.find((c) => c.file === "q.ts")!.fixes).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
