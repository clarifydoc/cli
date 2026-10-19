import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { editedFile, searchTerm } from "./hooks.js";
import { CLIENTS, applyPlans, mcpSnippet, planClaudeHooks, planGitHooks, planGuidance, planMcpConfig, planSkills, projectFacts } from "./install.js";

describe("hook payloads", () => {
  it("finds the name a search is after, and skips noise", () => {
    expect(searchTerm({ tool_input: { pattern: "def\\s+place_order" } })).toBe("place_order");
    expect(searchTerm({ tool_input: { pattern: "**/OrderService*.ts" } })).toBe("OrderService");
    expect(searchTerm({ tool_input: { command: "rg -n --type ts 'getUserById' src" } })).toBe("getUserById");
    expect(searchTerm({ tool_input: { pattern: "ab" } })).toBeNull();
    expect(searchTerm({ tool_input: { pattern: "function" } })).toBeNull();
  });

  it("reads the edited file relative to the project", () => {
    expect(editedFile({ tool_input: { file_path: "/repo/src/a.ts" } }, "/repo")).toBe("src/a.ts");
    expect(editedFile({ tool_input: { file_path: "/elsewhere/a.ts" } }, "/repo")).toBeNull();
  });
});

describe("install plans", () => {
  const self = { command: "clarifydoc", args: [] };
  it("merges the server into an existing MCP config and keeps the others", () => {
    const root = mkdtempSync(join(tmpdir(), "install-"));
    try {
      writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
      const plan = planMcpConfig("claude-code", root, self);
      expect(JSON.parse(plan.content)).toEqual({ mcpServers: { other: { command: "x" }, clarifydoc: { command: "clarifydoc", args: ["mcp"] } } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds each hook once, however often it runs", () => {
    const root = mkdtempSync(join(tmpdir(), "install-"));
    try {
      applyPlans([planClaudeHooks(root, self)], false);
      const again = JSON.parse(planClaudeHooks(root, self).content);
      expect(again.hooks.PreToolUse).toHaveLength(1);
      expect(again.hooks.PostToolUse[0].hooks[0].command).toBe("clarifydoc hook post-edit");
      expect(again.hooks.SessionStart).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces only its own AGENTS.md section, with the project's facts", () => {
    const root = mkdtempSync(join(tmpdir(), "install-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "# Team rules\n\nBe kind.\n");
      const facts = projectFacts({ godNodes: [{ file: "src/core.ts", degree: 40 }], apiRouteLinkStats: { unmatched: 3 } });
      applyPlans([planGuidance(root, "AGENTS.md", facts)], false);
      const twice = planGuidance(root, "AGENTS.md", facts).content;
      expect(twice.startsWith("# Team rules\n\nBe kind.\n\n<!-- clarifydoc:start -->")).toBe(true);
      expect(twice.match(/clarifydoc:start/g)).toHaveLength(1);
      expect(twice).toContain("`src/core.ts`");
      expect(twice).toContain("3 API call(s) reach no route");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns each MCP workflow prompt into a skill", () => {
    const skills = planSkills("/repo");
    expect(skills.length).toBeGreaterThanOrEqual(6);
    const first = skills.find((s) => s.file.endsWith("clarifydoc-before-editing/SKILL.md"))!;
    expect(first.content).toMatch(/^---\nname: clarifydoc-before-editing\ndescription: /);
    expect(first.content).toContain('clarifydoc_file path="<file>"');
  });
});

describe("git hooks", () => {
  const self = { command: "clarifydoc", args: [] };
  it("refresh in the background after commit, merge and branch checkout, keeping a hook's own lines", () => {
    const root = mkdtempSync(join(tmpdir(), "githooks-"));
    const hooksDir = join(root, "hooks");
    try {
      mkdirSync(hooksDir);
      writeFileSync(join(hooksDir, "post-merge"), "#!/bin/bash\necho mine\n");
      const first = planGitHooks(root, { hooksDir }, self);
      expect(first.map((p) => p.file.split("/").pop())).toEqual(["post-commit", "post-merge", "post-checkout"]);
      applyPlans(first, false);
      const commit = readFileSync(join(hooksDir, "post-commit"), "utf8");
      expect(commit.startsWith("#!/bin/sh\n# clarifydoc:start")).toBe(true);
      expect(commit).toContain(`'clarifydoc' analyze . -o '.clarifydoc' --incremental --no-lsp --no-pretty </dev/null >/dev/null 2>&1 &`);
      expect(statSync(join(hooksDir, "post-commit")).mode & 0o111).toBeTruthy();
      // The block goes after the hook's shebang, before its own lines.
      expect(readFileSync(join(hooksDir, "post-merge"), "utf8")).toMatch(/^#!\/bin\/bash\n# clarifydoc:start[\s\S]*# clarifydoc:end\necho mine\n$/);
      // A file checkout does not refresh.
      expect(readFileSync(join(hooksDir, "post-checkout"), "utf8")).toContain('if [ "$3" = "1" ]; then');
      // A second install replaces its block and nothing else.
      const again = planGitHooks(root, { hooksDir }, self);
      expect(again.map((p) => p.content)).toEqual(first.map((p) => readFileSync(p.file, "utf8")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mcp --print-config", () => {
  const self = { command: "clarifydoc", args: [] };
  it("prints each client's entry in its own format, a user-level one naming the project", () => {
    const all = Object.fromEntries(CLIENTS.map((c) => [c, mcpSnippet(c, "/repo", self)]));
    expect(JSON.parse(all["claude-code"]!.snippet)).toEqual({ mcpServers: { clarifydoc: { command: "clarifydoc", args: ["mcp"] } } });
    expect(all["claude-code"]!.file).toBe(join("/repo", ".mcp.json"));
    expect(JSON.parse(all.vscode!.snippet).servers.clarifydoc.type).toBe("stdio");
    expect(JSON.parse(all["claude-desktop"]!.snippet).mcpServers.clarifydoc.args).toEqual(["mcp", "/repo"]);
    expect(all.codex!.snippet).toBe('[mcp_servers.clarifydoc]\ncommand = "clarifydoc"\nargs = ["mcp","/repo"]\n');
    // The same entry install would merge in.
    expect(JSON.parse(planMcpConfig("cursor", mkdtempSync(join(tmpdir(), "pc-")), self).content).mcpServers.clarifydoc).toEqual(JSON.parse(all.cursor!.snippet).mcpServers.clarifydoc);
  });
});
