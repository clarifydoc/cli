import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitChangedFiles, gitChangedHunks, parseNameStatusZ } from "./git-changed-files.js";
import { computeImpactDiff, renderImpactMarkdown, renderImpactText } from "./impact-diff.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A repository with `files` committed; `git` runs in it under a fixed identity. */
function repo(files: Record<string, string>, config: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "rvd-changed-"));
  dirs.push(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t" } });
  git("init", "-q");
  for (const c of config) { const [k, v] = c.split("="); git("config", k!, v!); }
  const write = (p: string, text: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), text); };
  for (const [p, t] of Object.entries(files)) write(p, t);
  git("add", "."); git("commit", "-qm", "base");
  return { root, git, write };
}

const BODY = Array.from({ length: 12 }, (_, i) => `export const goal${i} = ${i};\n`).join("");

describe("E-385: the user's diff.interHunkContext never widens a hunk", () => {
  it.skipIf(process.platform === "win32")("two edits around an unchanged function stay two ranges", async () => {
    const lines = ["export function kickOff() { return 1; }\n", "export function whistle() { return 2; }\n", "export function fullTime() { return 3; }\n"];
    const r = repo({ "src/match.ts": lines.join("") }, ["diff.interHunkContext=5"]);
    r.write("src/match.ts", ["export function kickOff() { return 10; }\n", lines[1]!, "export function fullTime() { return 30; }\n"].join(""));
    expect([...(await gitChangedHunks(r.root)).get("src/match.ts")!]).toEqual([[1, 1], [3, 3]]);
  });
});

describe("the user's diff.algorithm never moves a hunk", () => {
  it.skipIf(process.platform === "win32")("hunks read the same under patience as under the default", async () => {
    const fn = (n: number, body: string) => `export function f${n}() {\n  if (x) {\n    ${body}\n  }\n  return ${n};\n}\n\n`;
    const old = [0, 1, 2, 3, 4, 5].map((i) => fn(i, "go();"));
    const next = old[0]! + old[2]! + old[3]! + fn(99, "go();") + old[4]! + fn(5, "stop();");
    const hunksOf = async (config: string[]) => {
      const r = repo({ "a.ts": old.join("") }, config);
      r.write("a.ts", next);
      return [...(await gitChangedHunks(r.root)).get("a.ts")!];
    };
    expect(await hunksOf(["diff.algorithm=patience"])).toEqual(await hunksOf([]));
  });
});

describe("E-393: renames", () => {
  it.skipIf(process.platform === "win32")("a pure git mv is one rename, under any diff.renames", async () => {
    for (const config of [[], ["diff.renames=false"]]) {
      const r = repo({ "src/club.ts": BODY, "src/index.ts": "import './club';\n" }, config);
      r.git("mv", "src/club.ts", "src/team.ts");
      for (const opts of [{ staged: true }, {}]) {
        const c = await gitChangedFiles(r.root, opts);
        expect(c.renamed).toEqual([{ from: "src/club.ts", to: "src/team.ts", similarity: 100 }]);
        expect([...c.files].sort()).toEqual(["src/club.ts", "src/team.ts"]);
        expect(c.added).toEqual(["src/team.ts"]);
      }
    }
  });

  it.skipIf(process.platform === "win32")("a move with an edit above the threshold is still a rename, with its similarity", async () => {
    const r = repo({ "src/club.ts": BODY });
    r.git("mv", "src/club.ts", "src/team.ts");
    r.write("src/team.ts", BODY.replace("goal3 = 3", "goal3 = 33"));
    const c = await gitChangedFiles(r.root);
    expect(c.renamed).toHaveLength(1);
    expect(c.renamed[0]!.similarity).toBeGreaterThan(50);
    expect(c.renamed[0]!.similarity).toBeLessThan(100);
    // The hunks read the move as the old path gone and the new one added, so the importers of the old path are charged.
    const hunks = await gitChangedHunks(r.root);
    expect([...hunks.keys()]).toContain("src/team.ts");
    expect(hunks.deleted?.has("src/club.ts") || hunks.old?.has("src/club.ts")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("a move below the threshold is a deletion and an addition, both listed", async () => {
    const r = repo({ "src/club.ts": BODY });
    r.git("mv", "src/club.ts", "src/team.ts");
    r.write("src/team.ts", "export const other = 'nothing in common';\n");
    const c = await gitChangedFiles(r.root);
    expect(c.renamed).toEqual([]);
    expect([...c.files].sort()).toEqual(["src/club.ts", "src/team.ts"]);
    expect(c.added).toEqual(["src/team.ts"]);
  });

  it.skipIf(process.platform === "win32")("a case-only rename lists both spellings", async () => {
    const r = repo({ "src/club.ts": BODY });
    r.git("mv", "src/club.ts", "src/tmp.ts");
    r.git("mv", "src/tmp.ts", "src/Club.ts");
    const c = await gitChangedFiles(r.root, { staged: true });
    expect(c.renamed).toEqual([{ from: "src/club.ts", to: "src/Club.ts", similarity: 100 }]);
    expect([...c.files].sort()).toEqual(["src/Club.ts", "src/club.ts"]);
  });

  it("reads -z output strictly: a path that leaves the root drops its row", () => {
    const out = ["R100", "src/club.ts", "src/team.ts", "M", "../outside.ts", "A", "/etc/passwd", "R090", "src/a.ts", "../b.ts", "M", "src/kept.ts", ""].join("\0");
    const r = parseNameStatusZ(out, "/repo");
    expect(r.renamed).toEqual([{ from: "src/club.ts", to: "src/team.ts", similarity: 100 }]);
    expect(r.files).toEqual(["src/club.ts", "src/team.ts", "src/a.ts", "src/kept.ts"]);
    expect(r.added).toEqual(["src/team.ts"]);
  });

  it("charges the importers of the old path, states the move and the incomplete list", () => {
    const summary = {
      files: ["src/club.ts", "src/index.ts"], routeMap: [],
      componentGraph: { nodes: [], edges: [{ source: "src/index.ts", target: "src/club.ts" }] },
      blastRadius: [{ filePath: "src/club.ts", affectedFiles: ["src/index.ts"], transitiveFiles: [], changeRisk: "moderate" }],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(summary, ["src/club.ts", "src/team.ts"], {
      addedFiles: ["src/team.ts"], renamedFiles: [{ from: "src/club.ts", to: "src/team.ts", similarity: 100 }], notes: ["git skipped exhaustive rename detection"],
    });
    expect(r.dependents).toEqual(["src/index.ts"]);
    expect(r.risk.level).not.toBe("low");
    expect(r.renamedFiles).toEqual([{ from: "src/club.ts", to: "src/team.ts", similarity: 100 }]);
    expect(r.limitations).toContain("git skipped exhaustive rename detection");
    expect(renderImpactText(r)).toContain("Renamed:  src/club.ts -> src/team.ts (100%)");
    expect(renderImpactMarkdown(r)).toContain("| Renamed | `src/club.ts` → `src/team.ts` (100%) |");
  });
});
