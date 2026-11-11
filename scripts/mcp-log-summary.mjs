#!/usr/bin/env node
// Summarize a CLARIFYDOC_MCP_LOG file: per tool, calls, total bytes and each section's share of them.
// Usage: node scripts/mcp-log-summary.mjs <log> [--top N]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const topAt = args.indexOf("--top");
const top = topAt >= 0 ? Math.max(1, Number(args.splice(topAt, 2)[1]) || 5) : 5;
const file = args[0];
if (!file) {
  console.error("usage: mcp-log-summary.mjs <log file> [--top N]");
  process.exit(2);
}

const tools = new Map();
for (const raw of readFileSync(file, "utf8").split("\n")) {
  if (!raw.trim()) continue;
  let line;
  try {
    line = JSON.parse(raw);
  } catch {
    continue;
  }
  if (typeof line.tool !== "string") continue;
  const t = tools.get(line.tool) ?? { calls: 0, bytes: 0, sections: new Map() };
  t.calls++;
  t.bytes += line.bytes ?? line.chars ?? 0;
  for (const [name, n] of Object.entries(line.sections ?? {})) t.sections.set(name, (t.sections.get(name) ?? 0) + n);
  tools.set(line.tool, t);
}

if (!tools.size) console.log("no tool calls in the log");
for (const [tool, t] of [...tools].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`${tool}: ${t.calls} call${t.calls === 1 ? "" : "s"}, ${t.bytes} bytes`);
  const measured = [...t.sections.values()].reduce((a, b) => a + b, 0);
  for (const [name, n] of [...t.sections].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(`  ${((100 * n) / (measured || 1)).toFixed(1).padStart(5)}%  ${String(n).padStart(8)}  ${name}`);
  }
}
