#!/usr/bin/env node
/**
 * Reduces a C or C++ file the ANTLR reader refuses to a minimal file it still refuses, so a person can read the
 * real cause. Usage: node scripts/reduce-refused-c.mjs <file> [--reader c|cpp] [--variant c-first] [--config first,second,off,asis] [--out <file>] [--max-reads <n>]
 *
 * Reads with the built readers (dist/), as scripts/c-family-failures.mjs does. The reduction itself is
 * scripts/lib/c-reduce.mjs: the conditional structure is settled first (`first` and `second` keep one branch of every
 * `#if`, as the reader's second attempt does, and reduce the flat text freely; `asis` keeps every directive and a
 * candidate keeps the `#if`/`#endif` balance and bracket depth), then the units before the first refused one (the
 * context), then the statements of that unit. For every configuration the reader refuses it reports where the reader
 * first refuses (the unit's line in the original file), so a stump can be told from a cause: a result whose first
 * refused unit is one line of a macro definition is a stump. Prints the smallest reduced text (or writes it to
 * --out; with several results `--out` is a prefix, one file per configuration). Exit 2 when the file is not refused.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIGS, reduceRefused } from "./lib/c-reduce.mjs";
import { loadEngine, option, positional } from "./lib/c-family.mjs";

const argv = process.argv.slice(2);
const usage = "usage: reduce-refused-c.mjs <file> [--reader c|cpp] [--variant c-first] [--config first,second,off,asis] [--out <file>] [--max-reads <n>]";
const file = positional(argv, ["reader", "variant", "out", "max-reads", "config"])[0];
if (!file) throw new Error(usage);
const reader = option(argv, "reader", /\.c$/i.test(file) ? "c" : "cpp");
const variant = option(argv, "variant") ?? undefined;
const configs = (option(argv, "config") ?? CONFIGS.join(",")).split(",");
const engine = await loadEngine();
const read = reader === "c" ? (s) => engine.readC(s) : (s) => engine.readCpp(s, undefined, variant);

const original = readFileSync(file, "utf8");
const { results, best, notRefused } = reduceRefused(original, (s) => read(s).syntaxErrors > 0, {
  configs,
  cplusplus: reader !== "c",
  maxReads: Number(option(argv, "max-reads", "4000")),
});
if (notRefused) {
  console.error(`${file}: the ${reader} reader reads it with no syntax error`);
  process.exit(2);
}
const out = option(argv, "out");
for (const r of results) {
  if (!r.text) {
    console.error(`[${r.config}] ${r.skipped}`);
    continue;
  }
  console.error(`[${r.config}] ${original.split("\n").length} lines -> ${r.text.trimEnd().split("\n").length}, ${r.reads} reads (${reader} reader)${r.notes.map((n) => `\n  ${n}`).join("")}`);
  if (out && results.filter((x) => x.text).length > 1) writeFileSync(`${out}.${r.config}`, r.text);
}
if (best) {
  if (out) writeFileSync(out, best.text);
  else process.stdout.write(best.text);
  console.error(`smallest: [${best.config}]`);
}
