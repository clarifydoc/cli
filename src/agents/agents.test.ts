import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { editedFile, searchTerm } from "./hooks.js";
import { applyPlans, planClaudeHooks, planGuidance, planMcpConfig, planSkills, projectFacts } from "./install.js";

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
