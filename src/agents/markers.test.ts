import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyPlans, planCodexHooks, planGitHooks, planGuidance } from "./install.js";

// E-209: install never rewrites a file whose markers are unbalanced or out of order.
describe("damaged markers", () => {
  const S = "<!-- clarifydoc:start -->";
  const E = "<!-- clarifydoc:end -->";
  const person = "# Team rules\n\nOur own paragraph about the Club.\n\n";
  const tail = "\n\nMore of the Player notes.\n";
  const cases: Record<string, string> = {
    "a lone start": `${person}${S}\nold block\n${tail}`,
    "a lone end": `${person}old block\n${E}${tail}`,
    "reversed markers": `${person}${E}\nold block\n${S}${tail}`,
    "two blocks": `${person}${S}\na\n${E}\nmiddle paragraph\n${S}\nb\n${E}${tail}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`AGENTS.md with ${name} is refused and never rewritten`, () => {
      const root = mkdtempSync(join(tmpdir(), "damaged-"));
      try {
        writeFileSync(join(root, "AGENTS.md"), text);
        for (let n = 0; n < 3; n++) {
          const plan = planGuidance(root, "AGENTS.md");
          expect(plan.skip, name).toMatch(/marker/);
          expect(plan.skip).toContain("nothing was changed");
          expect(applyPlans([plan], false)[0]).toContain("left ");
          expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(text);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("the end marker deleted by a person: three installs keep the paragraph", () => {
    const root = mkdtempSync(join(tmpdir(), "damaged-"));
    try {
      applyPlans([planGuidance(root, "AGENTS.md")], false);
      const first = readFileSync(join(root, "AGENTS.md"), "utf8");
      const edited = `${first.replace(E, "")}\nMy own paragraph.\n`;
      writeFileSync(join(root, "AGENTS.md"), edited);
      for (let n = 0; n < 3; n++) applyPlans([planGuidance(root, "AGENTS.md")], false);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(edited);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a balanced block is still replaced in place", () => {
    const root = mkdtempSync(join(tmpdir(), "damaged-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), `${person}${S}\nold\n${E}${tail}`);
      const plan = planGuidance(root, "AGENTS.md");
      expect(plan.skip).toBeUndefined();
      expect(plan.content.startsWith(person)).toBe(true);
      expect(plan.content.endsWith(tail.replace(/^\n/, ""))).toBe(true);
      expect(plan.content).not.toContain("old\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git hooks with a lone start, a lone end, reversed markers or two blocks are left alone", () => {
    const root = mkdtempSync(join(tmpdir(), "damaged-"));
    const hooksDir = join(root, "hooks");
    try {
      mkdirSync(hooksDir);
      const hs = "# clarifydoc:start";
      const he = "# clarifydoc:end";
      const bad = [`#!/bin/sh\n${hs}\necho mine\n`, `#!/bin/sh\necho mine\n${he}\n`, `#!/bin/sh\n${he}\necho mine\n${hs}\n`, `#!/bin/sh\n${hs}\na\n${he}\necho mine\n${hs}\nb\n${he}\n`];
      for (const text of bad) {
        writeFileSync(join(hooksDir, "post-commit"), text);
        const plan = planGitHooks(root, { hooksDir }, { command: "clarifydoc", args: [] }).find((p) => p.file.endsWith("post-commit"))!;
        expect(plan.skip).toContain("nothing was changed");
        applyPlans([plan], false);
        expect(readFileSync(join(hooksDir, "post-commit"), "utf8")).toBe(text);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Codex config.toml with a lone start, reversed markers or two blocks is refused; a lone end keeps the person's tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "damaged-"));
    const launcher = { command: "clarifydoc", args: [], script: "/opt/garage/lib/clarifydoc/dist/cli.js" };
    try {
      const hs = "# clarifydoc:hooks:start";
      const he = "# clarifydoc:hooks:end";
      const mine = 'model = "coupe"\n\n[mcp_servers.pitlane]\ncommand = "pitlane"\n';
      for (const text of [`${mine}${hs}\n`, `${mine}${he}\n${hs}\n`, `${mine}${hs}\n${he}\n${hs}\n${he}\n`]) {
        writeFileSync(join(dir, "config.toml"), text);
        expect(planCodexHooks(launcher, undefined, dir).skip).toContain("nothing was changed");
      }
      // A lone end after the person's own `command =` line: refused, never eaten.
      writeFileSync(join(dir, "config.toml"), `${mine}${he}\n`);
      expect(planCodexHooks(launcher, undefined, dir).skip).toContain("nothing was changed");
      // A lone end after our own tables (a table rewrite took the start comment): replaced, the person's lines kept.
      const own = '[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "old hook pre-search"\ntimeout = 10\n';
      writeFileSync(join(dir, "config.toml"), `${mine}\n${own}${he}\n`);
      const plan = planCodexHooks(launcher, undefined, dir);
      expect(plan.skip).toBeUndefined();
      expect(plan.content).toContain('[mcp_servers.pitlane]\ncommand = "pitlane"');
      expect(plan.content).not.toContain("old hook");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
