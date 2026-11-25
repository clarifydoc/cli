#!/usr/bin/env node
/**
 * Reduces a C or C++ file the ANTLR reader refuses to a minimal file it still refuses, so a person can read the
 * real cause. Usage: node scripts/reduce-refused-c.mjs <file> [--reader c|cpp] [--variant c-first] [--out <file>] [--max-reads <n>]
 *
 * Reads with the built readers (dist/), as scripts/c-family-failures.mjs does. The reduction keeps the file's
 * preprocessor structure honest: a candidate whose `#if`/`#endif` do not balance is never tried, and the
 * directives (`#define`, `#include`, conditionals) are removed only after the code, and only one by one or as a
 * whole conditional with its body, and a candidate that moves the code's bracket depth is never tried (a stump
 * the reader refuses for a reason of its own says nothing), so a form that fails only because of a macro or a declaration the lines before it make
 * stays together with that macro or declaration. Phases, each repeated until nothing more goes:
 *   1. units (a directive line, or a top-level declaration/definition) by delta debugging;
 *   2. whole statements inside the units left (never a line from the middle of one);
 *   3. directive lines and conditional pairs.
 * A reduced file is "refused" when the reader reports a syntax error; a candidate that changes the error into a
 * different one cannot be told apart, so read the result: the remaining lines are what the grammar cannot take
 * with the directives left in place. Exit 0 with the reduced text printed (or written to --out); exit 2 when the
 * file is not refused to begin with.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadEngine, option, positional } from "./lib/c-family.mjs";

const argv = process.argv.slice(2);
const file = positional(argv, ["reader", "variant", "out", "max-reads"])[0];
if (!file) throw new Error("usage: reduce-refused-c.mjs <file> [--reader c|cpp] [--variant c-first] [--out <file>] [--max-reads <n>]");
const reader = option(argv, "reader", /\.c$/i.test(file) ? "c" : "cpp");
const variant = option(argv, "variant") ?? undefined;
const maxReads = Number(option(argv, "max-reads", "4000"));
const engine = await loadEngine();
const read = reader === "c" ? (s) => engine.readC(s) : (s) => engine.readCpp(s, undefined, variant);

let reads = 0;
const cache = new Map();
/** True when the reader refuses the text. */
function refused(text) {
  if (cache.has(text)) return cache.get(text);
  if (++reads > maxReads) throw new Error(`more than ${maxReads} reads; raise --max-reads`);
  let r;
  try {
    r = read(text).syntaxErrors > 0;
  } catch {
    r = false;
  }
  cache.set(text, r);
  return r;
}

/** Logical lines: a backslash-newline joins the next line to its directive or macro. */
function logicalLines(text) {
  const raw = text.split("\n");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    while (line.endsWith("\\") && i + 1 < raw.length) line += "\n" + raw[++i];
    out.push(line);
  }
  return out;
}

const isDirective = (l) => /^[ \t]*#/.test(l);
const directiveKind = (l) => /^[ \t]*#[ \t]*(\w+)/.exec(l)?.[1] ?? "";

/** Net bracket depth change of a line, ignoring strings, characters and comments (a rough scan is enough to pick candidates). */
function netDepth(line) {
  const s = line.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, " ");
  let d = 0;
  for (const ch of s) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
  }
  return d;
}

/** `#if`/`#endif` balance of a list of lines, never negative. */
function conditionalsBalance(lines) {
  let depth = 0;
  for (const l of lines) {
    if (!isDirective(l)) continue;
    const k = directiveKind(l);
    if (k === "if" || k === "ifdef" || k === "ifndef") depth++;
    else if (k === "endif" && --depth < 0) return false;
  }
  return depth === 0;
}

const join = (lines) => lines.join("\n");
/** Net bracket depth of the code lines (directives left out): a removal must leave it where the file had it, or the reader refuses the stump for a reason of its own. */
const codeNet = (ls) => ls.reduce((n, l) => (isDirective(l) ? n : n + netDepth(l)), 0);
let wantNet = 0;
const tryLines = (lines) => conditionalsBalance(lines) && codeNet(lines) === wantNet && refused(join(lines));

const original = readFileSync(file, "utf8");
if (!refused(original)) {
  console.error(`${file}: the ${reader} reader reads it with no syntax error`);
  process.exit(2);
}
let lines = logicalLines(original);
wantNet = codeNet(lines);

const endsStatement = (l) => /[;}]\s*(\/\/.*|\/\*.*\*\/)?\s*$/.test(l);
const startsStatement = (ls, i) => {
  for (let k = i - 1; k >= 0; k--) {
    const l = ls[k];
    if (l.trim() === "") continue;
    return isDirective(l) || /[;{}:]\s*(\/\/.*|\/\*.*\*\/)?\s*$/.test(l) || /\*\/\s*$/.test(l);
  }
  return true;
};
// Phase 1: units — a directive line, or a top-level declaration or definition — by delta debugging. A unit starts at
// a line in column 0 (not a `}`, not a comment's middle) that follows the end of a statement or a directive, so a
// `#if` that closes a brace in each branch cannot throw off the split.
function units(ls) {
  const out = [];
  let cur = [];
  const flush = () => cur.length && (out.push(cur), (cur = []));
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (isDirective(l)) {
      flush();
      out.push([l]);
      continue;
    }
    if (/^[A-Za-z_]/.test(l) && startsStatement(ls, i)) flush();
    cur.push(l);
  }
  flush();
  return out;
}

function ddmin(list, test) {
  let n = 2;
  while (list.length >= 2) {
    const size = Math.ceil(list.length / n);
    let reduced = false;
    for (let start = 0; start < list.length; start += size) {
      const rest = [...list.slice(0, start), ...list.slice(start + size)];
      if (rest.length && test(rest)) {
        list = rest;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= list.length) break;
      n = Math.min(n * 2, list.length);
    }
  }
  return list;
}

const codeUnits = (us) => us.filter((u) => !(u.length === 1 && isDirective(u[0])));
// Keep every directive while the code goes; then the directives.
{
  const us = units(lines);
  const dirs = new Map(us.map((u, i) => [i, u]).filter(([, u]) => u.length === 1 && isDirective(u[0])));
  const codeIdx = us.map((_, i) => i).filter((i) => !dirs.has(i));
  const build = (idx) => us.flatMap((u, i) => (dirs.has(i) || idx.includes(i) ? u : []));
  const keep = ddmin(codeIdx, (idx) => tryLines(build(idx)));
  lines = build(keep);
}

// Phase 2: whole statements of what is left — a run of lines that starts where the previous statement ended and
// closes its brackets on a line ending in `;` or `}` — never a line from the middle of one, so a removal cannot
// leave half a declaration for the reader to refuse for another reason.
function lineSweep(ls) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ls.length; i++) {
      if (isDirective(ls[i]) || ls[i].trim() === "" || !startsStatement(ls, i)) continue;
      let depth = 0;
      let j = i;
      for (; j < ls.length; j++) {
        if (isDirective(ls[j])) break;
        depth += netDepth(ls[j]);
        if (depth <= 0 && endsStatement(ls[j])) break;
      }
      if (j >= ls.length || isDirective(ls[j]) || depth !== 0 || !endsStatement(ls[j])) continue;
      const cand = [...ls.slice(0, i), ...ls.slice(j + 1)];
      if (tryLines(cand)) {
        ls = cand;
        changed = true;
        i--;
      }
    }
  }
  return ls;
}
lines = lineSweep(lines);

// Phase 3: directives, one by one; a conditional pair through its `#endif` (the branches stay).
function directiveSweep(ls) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < ls.length; i++) {
      if (!isDirective(ls[i])) continue;
      const kind = directiveKind(ls[i]);
      let cand;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
        let depth = 0;
        let end = -1;
        for (let j = i; j < ls.length; j++) {
          const k = isDirective(ls[j]) ? directiveKind(ls[j]) : "";
          if (k === "if" || k === "ifdef" || k === "ifndef") depth++;
          else if (k === "endif" && --depth === 0) {
            end = j;
            break;
          }
        }
        if (end < 0) continue;
        // drop the conditional and everything under it
        cand = [...ls.slice(0, i), ...ls.slice(end + 1)];
      } else if (kind === "endif") continue;
      else cand = ls.filter((_, j) => j !== i);
      if (tryLines(cand)) {
        ls = cand;
        changed = true;
        i--;
      }
    }
  }
  return ls;
}
lines = directiveSweep(lines);
lines = lineSweep(lines);

const result = join(lines).replace(/\n{3,}/g, "\n\n") + "\n";
if (!refused(result)) throw new Error("internal: the reduced text is no longer refused");
const out = option(argv, "out");
if (out) writeFileSync(out, result);
else process.stdout.write(result);
console.error(`${file}: ${original.split("\n").length} lines -> ${result.trimEnd().split("\n").length}, ${reads} reads (${reader} reader)`);
