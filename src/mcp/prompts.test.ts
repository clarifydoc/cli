import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildMcpServer } from "./server.js";
import { WORKFLOW_PROMPTS } from "./prompts.js";
import { AGENT_GUIDANCE, INSTRUCTIONS } from "./guidance.js";

// Prompts and guidance tell a model which tool to call with which arguments.
// A name or argument that does not exist sends it into an error it cannot
// diagnose, so every one is checked against the tools the server registers.
const dir = mkdtempSync(join(tmpdir(), "clarifydoc-prompts-"));
const tools = new Map(
  buildMcpServer({ projectRoot: dir, analysisDir: dir, allowAnalyze: false, allowColdStart: false }).tools.map((t) => [
    t.name,
    Object.keys(((t.inputSchema as { properties?: object }).properties ?? {}) as object),
  ]),
);

/** Each `clarifydoc_x a=… b=…` in a text: the tool and the argument names. */
function calls(text: string): { tool: string; args: string[] }[] {
  const out: { tool: string; args: string[] }[] = [];
  for (const m of text.matchAll(/\b(clarifydoc_\w+)((?:\s+\w+=(?:"[^"]*"|\[[^\]]*\]|<[^>]*>|\S+))*)/g)) {
    out.push({ tool: m[1]!, args: [...m[2]!.matchAll(/(\w+)=/g)].map((a) => a[1]!) });
  }
  return out;
}

function sampleArgs(p: (typeof WORKFLOW_PROMPTS)[number]): Record<string, string> {
  return Object.fromEntries(p.arguments.map((a) => [a.name, `sample-${a.name}`]));
}

describe("workflow prompts and agent guidance", () => {
  it("name only tools the server has", () => {
    const texts = [INSTRUCTIONS, AGENT_GUIDANCE, ...WORKFLOW_PROMPTS.map((p) => p.render(sampleArgs(p)))];
    for (const text of texts) {
      for (const c of calls(text)) expect(tools.has(c.tool), c.tool).toBe(true);
    }
  });

  it("pass only arguments those tools accept", () => {
    for (const p of WORKFLOW_PROMPTS) {
      for (const c of calls(p.render(sampleArgs(p)))) {
        for (const arg of c.args) expect(tools.get(c.tool), `${p.name}: ${c.tool} ${arg}=`).toContain(arg);
      }
    }
  });

  it("render with only their required arguments", () => {
    for (const p of WORKFLOW_PROMPTS) {
      const required = Object.fromEntries(p.arguments.filter((a) => a.required).map((a) => [a.name, `x-${a.name}`]));
      expect(p.render(required)).not.toMatch(/undefined/);
    }
  });

  it("keeps the guidance a self-contained markdown section", () => {
    expect(AGENT_GUIDANCE.startsWith("## ClarifyDoc\n")).toBe(true);
    expect(AGENT_GUIDANCE).toContain("`clarifydoc_routes`");
  });
});
