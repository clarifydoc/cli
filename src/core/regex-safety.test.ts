import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-regex-safety.mjs");

/** Runs the check over one file holding `source`, with an optional allow-list; its exit status and report. */
function check(source: string, allow: Record<string, string> = {}): { status: number | null; report: string } {
  const dir = mkdtempSync(join(tmpdir(), "regex-safety-"));
  writeFileSync(join(dir, "club.ts"), source);
  writeFileSync(join(dir, "allow.json"), JSON.stringify(allow));
  const run = spawnSync("node", [script, dir, join(dir, "allow.json")], { encoding: "utf8" });
  return { status: run.status, report: run.stderr };
}

describe("check-regex-safety", () => {
  // It parses every source file: seconds on a loaded machine.
  it("passes on the sources as they are", () => {
    expect(execFileSync("node", [script], { encoding: "utf8" })).toContain("no unsafe shape");
  }, 60_000);

  it("fails on a hand-rolled escape that leaves the backslash, and passes a glob escape that keeps it", () => {
    const bad = check('const at = new RegExp(`${name.replace(/\\$/g, "\\\\$")}\\\\(`);');
    expect(bad.status).toBe(1);
    expect(bad.report).toContain("club.ts:1  escape");
    expect(check('const glob = pattern.replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&");').status).toBe(0);
  });

  it("fails on a repeated group whose inner run can swallow an iteration, before something that can fail", () => {
    for (const shape of [
      "/\\(\\s*this\\.car(?:\\s+(?:as|satisfies)\\s+[^()]+?)*\\s*\\)/g",
      "/\\.parse\\(\\)(?:\\s*(?:\\?|\\.ok\\(\\)|\\.map_err\\([\\s\\S]*\\)))*\\s*$/",
      "/^(\\w+\\s?)*$/",
    ]) {
      const run = check(`const CAST = ${shape};`);
      expect(run.status, shape).toBe(1);
      expect(run.report).toContain("nested");
    }
  });

  it("passes runs a delimiter stops, groups at the end of a pattern and separators the run cannot cross", () => {
    for (const shape of [
      `/<(?:"[^"]*"|'[^']*'|[^>'"])*>/`,
      "/^[\\w.]+(?:\\s*,\\s*[^,;]+)*;/",
      "/^(?:\\s+|\\/\\/[^\\n]*)*/",
      "/\\(\\s*this\\.car(?:\\s+(?:as|satisfies)\\s[^()]*|\\s*)\\)/g",
    ])
      expect(check(`const SHAPE = ${shape};`).status, shape).toBe(0);
  });

  it("fails on an HTML comment end written as `-->` only, and leaves Mermaid arrows and `--!?>` alone", () => {
    expect(check("const end = /\\*\\/|-->\\s*$/;").report).toContain("comment");
    expect(check("const strip = /<!--[\\s\\S]*?-->/g;").status).toBe(1);
    expect(check("const strip = /<!--[\\s\\S]*?--!?>/g;").status).toBe(0);
    expect(check("const edge = /^ {2}(\\w+) (-->|-\\.->) (\\w+)$/;").status).toBe(0);
  });

  it("reads patterns built by RegExp from strings, String.raw and +, and honours the allow-list", () => {
    expect(check('const re = new RegExp("\\\\.go\\\\(\\\\)(?:\\\\s*(?:\\\\?|\\\\.x\\\\([\\\\s\\\\S]*\\\\)))*" + "\\\\s*$");').status).toBe(1);
    expect(check("const re = new RegExp(String.raw`<!--${tag}-->`);").status).toBe(1);
    const xml = "const strip = /<!--[\\s\\S]*?-->/g;";
    expect(check(xml, { "club.ts:comment:<!--[\\s\\S]*?-->": "XML: a comment ends only at -->" }).status).toBe(0);
  });
});
