#!/usr/bin/env node
/**
 * Prefix bisect: which earlier file (and which line of it) changes how one file is read. Usage:
 *   node scripts/c-family-bisect.mjs <repo-dir> --file <relative path> [--order forward|reverse]
 * Reads the files before <file> (sorted order, or after it when `reverse`) and then <file> in a fresh process and
 * compares with <file> read alone; when they differ, halves the prefix until one file is enough to change it, then
 * halves that file's lines (truncated at line m). Every probe is a new process, so it takes about a second each.
 * Uses the built readers (dist/); the answer is a lead, since the changing state may need several files.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, listFiles, loadEngine, nameOf, option, positional, readOne } from "./lib/c-family.mjs";

const argv = process.argv.slice(2);

/** Probe mode: read each item (the last cut to its `lines`, when given) and print the last one's reading. */
if (argv.includes("--probe")) {
  const items = JSON.parse(readFileSync(option(argv, "probe"), "utf8"));
  const engine = await loadEngine();
  let last = "";
  for (const it of items) {
    let text = readFileSync(it.abs, "utf8");
    if (it.lines != null) text = text.split("\n").slice(0, it.lines).join("\n");
    try {
      const r = readOne(engine, it.group, text);
      last = r.skipped ? `skipped:${r.skipped}` : canonical(r.parsed);
    } catch (e) {
      last = `threw:${e?.message ?? e}`;
    }
  }
  process.stdout.write(last);
  process.exit(0);
}

const dir = positional(argv, ["file", "order"])[0];
const target = option(argv, "file");
const order = option(argv, "order", "forward");
if (!dir || !target) throw new Error("usage: c-family-bisect.mjs <repo-dir> --file <relative path> [--order forward|reverse]");
const tmp = mkdtempSync(join(tmpdir(), "c-family-bisect-"));
let probes = 0;
const probe = (items) => {
  const f = join(tmp, "items.json");
  writeFileSync(f, JSON.stringify(items));
  probes++;
  const r = spawnSync(process.execPath, [process.argv[1], "--probe", f], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`probe failed: ${r.stderr}`);
  return r.stdout;
};
const all = listFiles(dir);
const at = all.findIndex((f) => f.rel === target);
if (at < 0) throw new Error(`${target} is not a C or C++ file of ${dir}`);
const self = all[at];
const prefix = order === "reverse" ? all.slice(at + 1).reverse() : all.slice(0, at);
const base = probe([self]);
console.log(`${nameOf(dir)}: ${target}, ${order} order, ${prefix.length} files before it`);
try {
  if (probe([...prefix, self]) === base) {
    console.log("the reading after the whole prefix equals the reading alone: nothing to bisect in this order");
    process.exit(0);
  }
  // Smallest k for which the first k files of the prefix change the reading.
  let lo = 1;
  let hi = prefix.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (probe([...prefix.slice(0, mid), self]) !== base) hi = mid;
    else lo = mid + 1;
  }
  const culprit = prefix[lo - 1];
  const alone = probe([culprit, self]) !== base;
  console.log(`first file that changes it: ${culprit.rel} (prefix position ${lo} of ${prefix.length}); ${alone ? "it alone is enough" : "needs the files before it as well"}`);
  // Smallest line count m of the culprit that still changes the reading.
  const before = alone ? [] : prefix.slice(0, lo - 1);
  const total = readFileSync(culprit.abs, "utf8").split("\n").length;
  let a = 1;
  let b = total;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (probe([...before, { ...culprit, lines: mid }, self]) !== base) b = mid;
    else a = mid + 1;
  }
  const line = readFileSync(culprit.abs, "utf8").split("\n")[a - 1] ?? "";
  console.log(`first ${a} of ${total} lines of ${culprit.rel} are enough; line ${a}: ${line.trim().slice(0, 160)}`);
  console.log(`(${probes} probes)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
