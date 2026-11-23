import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeImpactDiff, renderImpactMarkdown, renderImpactText } from "./impact-diff.js";
import { gitChangedFiles } from "./git-changed-files.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const summary = { files: ["src/club.ts"], blastRadius: [], routeMap: [] } as unknown as ProjectAnalysis;

describe("addedFiles in the impact report", () => {
  it("is stated apart from unknownFiles, and absent when the caller does not know", () => {
    const r = computeImpactDiff(summary, ["src/club.ts", "src/garage.ts", "docs/notes.md"], { addedFiles: ["./src/garage.ts"] });
    expect(r.addedFiles).toEqual(["src/garage.ts"]);
    expect(r.unknownFiles).toEqual(["docs/notes.md", "src/garage.ts"]);
    expect(computeImpactDiff(summary, ["src/club.ts"]).addedFiles).toBeUndefined();
    expect(renderImpactText(r)).toContain("Added:    src/garage.ts");
    expect(renderImpactMarkdown(r)).toContain("`src/garage.ts`");
  });

  it.skipIf(process.platform === "win32")("git names staged-new and untracked files as added, not an edited one", async () => {
    const root = mkdtempSync(join(tmpdir(), "rvd-added-"));
    try {
      const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_NAME: "t", GIT_COMMITTER_NAME: "t" } });
      git("init", "-q");
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/club.ts"), "export const a = 1;\n");
      git("add", "."); git("commit", "-qm", "base");
      writeFileSync(join(root, "src/club.ts"), "export const a = 2;\n");
      writeFileSync(join(root, "src/player.ts"), "export const p = 1;\n");
      git("add", "src/player.ts");
      writeFileSync(join(root, "src/match.ts"), "export const m = 1;\n");
      const r = await gitChangedFiles(root);
      expect([...r.added].sort()).toEqual(["src/match.ts", "src/player.ts"]);
      expect(r.files).toContain("src/club.ts");
      expect((await gitChangedFiles(root, { staged: true })).added).toEqual(["src/player.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
