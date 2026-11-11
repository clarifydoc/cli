import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { isTreeMovingGit, runHook, startRefresh } from "./hooks.js";
import { applyPlans, planClaudeHooks, planCodexHooks, planCopilotHooks } from "./install.js";

const self = { command: "clarifydoc", args: [] as string[] };

describe("post-git hook", () => {
  it("matches the commands that move the working tree, however they are written", () => {
    for (const c of [
      "git commit -m 'Add Club'",
      "git -C ../garage commit --amend",
      "cd garage && git checkout -b pit-stop",
      "git -c user.name=Coach switch main",
      "FOO=1 git pull --rebase",
      "npm test; git merge league",
      "git rebase -i HEAD~3 | cat",
      "(cd garage && git commit -m x)",
      "command git checkout main",
      "git reset --hard HEAD~1",
      "git cherry-pick abc123",
    ]) expect(isTreeMovingGit(c), c).toBe(true);
    for (const c of [
      "git status",
      "git log --oneline",
      "ls -la",
      "echo 'git commit' > note.txt",
      'echo "run git checkout later"',
      "git diff HEAD~1",
      "grep -rn commit src",
      "digit commit",
    ]) expect(isTreeMovingGit(c), c).toBe(false);
  });

  it("starts one refresh for a commit and none for anything else, and never prints", async () => {
    const root = mkdtempSync(join(tmpdir(), "post-git-"));
    try {
      const started: string[] = [];
      const refresh = (r: string, dir: string) => started.push(`${r}|${dir}`);
      const payload = (command: string, tool = "Bash") => ({ cwd: root, tool_name: tool, tool_input: { command } });
      // No analysis yet: the hook never cold-starts one.
      expect(await runHook("post-git", payload("git commit -m x"), root, "claude", "clarifydoc", refresh)).toBeNull();
      expect(started).toEqual([]);
      const out = join(root, ".clarifydoc", basename(root));
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "project-summary.json"), "{}");
      expect(await runHook("post-git", payload("git commit -m x"), root, "claude", "clarifydoc", refresh)).toBeNull();
      expect(started).toHaveLength(1);
      await runHook("post-git", payload("ls"), root, "claude", "clarifydoc", refresh);
      await runHook("post-git", payload("git commit -m x", "Edit"), root, "claude", "clarifydoc", refresh);
      await runHook("post-git", { cwd: root, toolName: "bash", toolArgs: JSON.stringify({ command: "git switch main" }) }, root, "copilot", "clarifydoc", refresh);
      expect(started).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coalesces refreshes while one is running", () => {
    const dir = mkdtempSync(join(tmpdir(), "post-git-lock-"));
    try {
      // A live pid holds the lock: nothing is spawned and the lock stays.
      writeFileSync(join(dir, ".hook-refresh.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      startRefresh(dir, dir);
      expect(JSON.parse(readFileSync(join(dir, ".hook-refresh.lock"), "utf8")).pid).toBe(process.pid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is wired after Bash in Claude Code, Copilot and a Codex hooks.json", () => {
    const root = mkdtempSync(join(tmpdir(), "post-git-install-"));
    try {
      const claude = JSON.parse(planClaudeHooks(root, self).content);
      expect(claude.hooks.PostToolUse.map((h: { matcher: string }) => h.matcher)).toEqual(["Edit|Write|MultiEdit", "Bash"]);
      expect(claude.hooks.PostToolUse[1].hooks[0].command).toBe("clarifydoc hook post-git");
      applyPlans([planClaudeHooks(root, self)], false);
      expect(JSON.parse(planClaudeHooks(root, self).content).hooks.PostToolUse).toHaveLength(2);

      const copilot = JSON.parse(planCopilotHooks(self, "/home/driver/.copilot").content).hooks.PostToolUse;
      expect(copilot[1].bash).toContain("hook post-git --dialect copilot");

      writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: {} }));
      const codex = JSON.parse(planCodexHooks(self, undefined, root).content);
      expect(codex.hooks.PostToolUse[0].hooks[0].command).toMatch(/hook post-git$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
