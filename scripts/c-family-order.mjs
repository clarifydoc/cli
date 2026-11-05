#!/usr/bin/env node
/**
 * Forward vs reverse order: reads <repo-dir>'s C and C++ files in sorted order in one process and in reverse order in
 * another, and prints every file whose functions or calls differ. Usage: node scripts/c-family-order.mjs <repo-dir> [--examples 5]
 * A reading must depend on the file's own bytes only; a file listed here was read differently because of the files read before it.
 * Uses the built readers (dist/). Exit status 1 when any file differs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, listFiles, loadEngine, nameOf, option, positional, readOne } from "./lib/c-family.mjs";

const argv = process.argv.slice(2);

/** Child mode: read in the given order, write one canonical reading per file as JSON lines. */
if (argv.includes("--child")) {
  const [dir, order, out] = [option(argv, "dir"), option(argv, "order"), option(argv, "out")];
  const engine = await loadEngine();
  const files = listFiles(dir);
  if (order === "reverse") files.reverse();
  const lines = [];
  for (const f of files) {
    let r;
    try {
      r = readOne(engine, f.group, readFileSync(f.abs, "utf8"));
    } catch (e) {
      r = { skipped: `threw: ${e?.message ?? e}` };
    }
    lines.push(JSON.stringify([f.rel, r.skipped ? `skipped:${r.skipped}` : canonical(r.parsed)]));
  }
  writeFileSync(out, lines.join("\n"));
  process.exit(0);
}

const dir = positional(argv, ["examples"])[0];
if (!dir) throw new Error("usage: c-family-order.mjs <repo-dir> [--examples n]");
const examples = Number(option(argv, "examples", 5));
const tmp = mkdtempSync(join(tmpdir(), "c-family-order-"));
const run = (order) => {
  const out = join(tmp, `${order}.jsonl`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [process.argv[1], "--child", "--dir", dir, "--order", order, "--out", out], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${order} pass failed`);
  return { ms: Date.now() - t0, map: new Map(readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) };
};
const fwd = run("forward");
const rev = run("reverse");
rmSync(tmp, { recursive: true, force: true });

const namesOf = (c) => {
  if (c.startsWith("skipped:")) return { errors: c, fns: new Set(), calls: new Set() };
  const p = JSON.parse(c);
  const fns = new Set(p.f.map((f) => `${f.name}@${f.line}-${f.endLine}`));
  const calls = new Set(p.f.flatMap((f) => (f.calls ?? []).map((k) => `${f.name}>${k.name}@${k.line}`)));
  return { errors: p.e, fns, calls };
};
const only = (a, b) => [...a].filter((x) => !b.has(x));
const differing = [];
for (const [file, a] of fwd.map) {
  const b = rev.map.get(file);
  if (a === b) continue;
  const x = namesOf(a);
  const y = namesOf(b);
  differing.push({ file, errors: x.errors === y.errors ? null : `${x.errors} / ${y.errors}`, fnF: only(x.fns, y.fns), fnR: only(y.fns, x.fns), callF: only(x.calls, y.calls), callR: only(y.calls, x.calls) });
}
console.log(`${nameOf(dir)}: ${fwd.map.size} files, forward ${(fwd.ms / 1000).toFixed(1)} s, reverse ${(rev.ms / 1000).toFixed(1)} s, ${differing.length} differ`);
for (const d of differing) {
  console.log(`DIFF ${d.file}${d.errors ? ` (syntax errors forward/reverse: ${d.errors})` : ""}: functions only forward ${d.fnF.length}, only reverse ${d.fnR.length}; calls only forward ${d.callF.length}, only reverse ${d.callR.length}`);
  for (const [label, list] of [["fn forward", d.fnF], ["fn reverse", d.fnR], ["call forward", d.callF], ["call reverse", d.callR]]) for (const s of list.slice(0, examples)) console.log(`    ${label}: ${s}`);
}
process.exit(differing.length > 0 ? 1 : 0);
