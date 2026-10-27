#!/usr/bin/env node
// Install a packed `clarifydoc` tarball into an empty directory, the way a user
// would, and prove it works there: every tree-sitter grammar loads (none falls
// back to regex), and the MCP server answers `initialize` and `tools/list`.
//
//   node scripts/smoke-tarball.mjs <clarifydoc-x.y.z.tgz>
//
// Self-contained: it writes one small source file per tree-sitter language
// rather than reading fixtures, so it runs wherever the tarball does.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2] && resolve(process.argv[2]);
if (!tarball) {
  console.error("usage: node scripts/smoke-tarball.mjs <clarifydoc-x.y.z.tgz>");
  process.exit(2);
}

/** One file per language the analyzer parses with a tree-sitter grammar, each declaring `greet`. */
const SOURCES = {
  "a.ts": "export function greet(name: string): string { return `hi ${name}`; }\n",
  "b.js": "export function greet(name) { return 'hi ' + name; }\n",
  "c.py": "def greet(name):\n    return 'hi ' + name\n",
  "D.java": "public class D { public String greet(String name) { return \"hi \" + name; } }\n",
  "E.kt": "fun greet(name: String): String = \"hi $name\"\n",
  "F.cs": "public class F { public string Greet(string name) { return \"hi \" + name; } }\n",
  "g.php": "<?php\nfunction greet($name) { return 'hi ' . $name; }\n",
  "h.pas": "unit h;\ninterface\nfunction Greet(const Name: string): string;\nimplementation\nfunction Greet(const Name: string): string;\nbegin\n  Result := 'hi ' + Name;\nend;\nend.\n",
  "i.fs": "module I\nlet greet name = \"hi \" + name\n",
  "j.sh": "greet() {\n  echo \"hi $1\"\n}\n",
  "k.R": "greet <- function(name) {\n  paste('hi', name)\n}\n",
  "l.jl": "function greet(name)\n  \"hi $name\"\nend\n",
  "m.zig": "pub fn greet(name: []const u8) []const u8 {\n    return name;\n}\n",
  "n.ml": "let greet name = \"hi \" ^ name\n",
  // Regex languages read by a tree-sitter front end: their grammars must load too.
  "o.swift": "func greet(_ name: String) -> String {\n    \"hi \\(name)\"\n}\n",
  "p.dart": "String greet(String name) {\n  return 'hi ' + name;\n}\n",
  "q.ex": "defmodule Q do\n  def greet(name), do: \"hi \" <> name\nend\n",
  "r.scala": "object R {\n  def greet(name: String): String = \"hi \" + name\n}\n",
  "s.m": "@implementation S\n- (NSString *)greet:(NSString *)name {\n  return [@\"hi \" stringByAppendingString:name];\n}\n@end\n",
};

const work = mkdtempSync(join(tmpdir(), "clarifydoc-smoke-"));
const problems = [];
try {
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: work, stdio: "inherit" });
  const bin = join(work, "node_modules", ".bin", process.platform === "win32" ? "clarifydoc.cmd" : "clarifydoc");

  const project = join(work, "project");
  mkdirSync(project);
  for (const [file, text] of Object.entries(SOURCES)) writeFileSync(join(project, file), text);
  execFileSync(bin, ["analyze", project, "-o", join(work, "out"), "--no-lsp", "--no-git-history"], { stdio: "ignore", shell: process.platform === "win32" });

  const outDir = join(work, "out", "project");
  for (const file of Object.keys(SOURCES)) {
    let analysis;
    try {
      analysis = JSON.parse(readFileSync(join(outDir, `${file}.json`), "utf8"));
    } catch {
      problems.push(`${file}: not analyzed`);
      continue;
    }
    if (analysis.extraction?.reason === "grammar-unavailable") problems.push(`${file}: grammar did not load (${analysis.language})`);
    else if (/\.(swift|dart|ex|scala|m)$/.test(file) && (analysis.frontEnd?.parser !== "tree-sitter" || analysis.frontEnd.fallback)) {
      problems.push(`${file}: the tree-sitter front end did not read it (${JSON.stringify(analysis.frontEnd ?? null)})`);
    }
    else {
      // A class method in Java/C#; in OCaml the file is its module, so a method of that class.
      const names = [
        ...(analysis.functions ?? []).map((f) => f.name),
        ...(analysis.classes ?? []).flatMap((c) => (c.methods ?? []).map((m) => m.name)),
      ];
      if (!names.some((n) => /^greet$/i.test(n))) problems.push(`${file}: no greet function found`);
    }
  }

  // MCP: initialize + tools/list over stdio.
  const answers = await new Promise((resolveAnswers, reject) => {
    const child = spawn(bin, ["mcp", project, "--no-cold-start"], { stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32" });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP server did not answer within 20s")); }, 20_000);
    child.stdout.on("data", (d) => {
      out += d;
      const lines = out.trim().split("\n").filter(Boolean);
      if (lines.length >= 2) {
        clearTimeout(timer);
        child.kill();
        resolveAnswers(lines.map((l) => JSON.parse(l)));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
  const version = answers.find((m) => m.id === 1)?.result?.serverInfo?.version;
  const tools = answers.find((m) => m.id === 2)?.result?.tools?.length ?? 0;
  if (!version) problems.push("MCP: no serverInfo.version in the initialize answer");
  if (tools < 10) problems.push(`MCP: tools/list returned ${tools} tools`);

  const size = (dir) => readdirSync(dir).reduce((n, f) => {
    const p = join(dir, f);
    return n + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
  }, 0);
  console.log(`installed ${(size(join(work, "node_modules")) / 1024 / 1024).toFixed(1)} MB · ${Object.keys(SOURCES).length} grammars checked · MCP ${version} with ${tools} tools`);
} catch (err) {
  problems.push(String(err?.message ?? err));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`smoke-tarball: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("smoke-tarball: ok");
