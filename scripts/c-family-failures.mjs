#!/usr/bin/env node
/**
 * Per reader (C `.c`, C++ sources, `.h` headers read as C++ then C): files read, files left to the line patterns
 * (a syntax error), their share and the speed. Usage: node scripts/c-family-failures.mjs <repo-dir> [--lang go|lua|rust] [--list] [--json <file>] [--routing project|plain]
 * Reads <repo-dir>'s C and C++ files with the built readers (dist/), forward order, one process: run one
 * directory per call for cold numbers. `--list` prints the failing files. A generated file or one past 2 M
 * characters is counted apart (no front end reads it).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { GROUPS as C_GROUPS, LANGUAGES, listFiles, loadEngine, nameOf, option, positional, readOne, table, variantsOf } from "./lib/c-family.mjs";

const argv = process.argv.slice(2);
const lang = option(argv, "lang");
if (lang && !LANGUAGES[lang]) throw new Error(`--lang is one of ${Object.keys(LANGUAGES).join(", ")}`);
const GROUPS = lang ? [{ id: lang, label: `${lang} (${LANGUAGES[lang].exts.join(" ")})` }] : C_GROUPS;
const dir = positional(argv, ["json", "lang", "routing"])[0];
if (!dir) throw new Error("usage: c-family-failures.mjs <repo-dir> [--lang go|lua|rust] [--list] [--json <file>] [--routing project|plain]");
const engine = await loadEngine(lang);
const files = listFiles(dir, lang);
// C/C++ headers are read the way the analyzer routes them for their project; `--routing plain` reads them as before.
const variants = variantsOf(engine, files, option(argv, "routing", "project"));
const stats = Object.fromEntries(GROUPS.map((g) => [g.id, { files: 0, failed: 0, skipped: 0, bytes: 0, ms: 0, failing: [] }]));
for (const f of files) {
  const source = readFileSync(f.abs, "utf8");
  const s = stats[f.group];
  const t0 = process.hrtime.bigint();
  let r;
  try {
    r = readOne(engine, f.group, source, variants.get(f.rel));
  } catch {
    r = { parsed: { syntaxErrors: 1 } };
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.skipped) {
    s.skipped++;
    continue;
  }
  s.files++;
  s.bytes += Buffer.byteLength(source);
  s.ms += ms;
  if (r.parsed.syntaxErrors > 0) {
    s.failed++;
    s.failing.push(f.rel);
  }
}
const pct = (n, d) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const rows = GROUPS.map((g) => {
  const s = stats[g.id];
  return [g.label, s.files, s.failed, pct(s.failed, s.files), s.skipped, (s.bytes / 1e6).toFixed(1), s.ms === 0 ? "-" : (s.bytes / 1e6 / (s.ms / 1000)).toFixed(2)];
});
console.log(`${nameOf(dir)}  (engine ${engine.version})`);
console.log(table(rows, ["reader", "files read", "fall back", "%", "not parsed", "MB", "MB/s"]));
if (argv.includes("--list")) for (const g of GROUPS) for (const f of stats[g.id].failing) console.log(`${g.id}\t${f}`);
const json = option(argv, "json");
if (json) writeFileSync(json, JSON.stringify({ dir: nameOf(dir), version: engine.version, stats }, null, 2));
