#!/usr/bin/env node
/**
 * A/B test of a feature (core/feature-flags.ts): analyzes one tree twice with the built CLI — A with the
 * feature switched off, B with it on, whatever its default — and reports what B changed, from the file level
 * up to the links:
 *
 * - each arm's wall time;
 * - per language: files B's front end read, and the ones it handed back to the patterns (syntax errors);
 * - functions: found by both, by one arm only, and for the ones both found whether the spans agree;
 * - calls: per function both found, the call names only A or only B records;
 * - the project: call→definition links gained and lost, and the size of every other result.
 *
 * Every disagreement kind comes with examples (file:line and the source line), which is what decides which
 * arm is right: the counts say how much differs, the examples say who is wrong.
 *
 *   node scripts/ab-features.mjs <project> [--feature antlr] [--out <dir>] [--examples 8] [--json <file>] [--reuse]
 *
 * `--reuse` compares the outputs an earlier run left in `--out` instead of analyzing again (no timing).
 * Build first (`npm run build`). Both arms run with --no-lsp --no-git-history --stable-output and never
 * --incremental, so neither reuses the other's cache.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

function parseArgs(argv) {
  const opts = { feature: "antlr", examples: 8, out: null, json: null, project: null, reuse: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--feature") opts.feature = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--examples") opts.examples = Number(argv[++i]);
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--reuse") opts.reuse = true;
    else if (!opts.project) opts.project = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!opts.project) throw new Error("usage: ab-features.mjs <project> [--feature antlr] [--out <dir>] [--examples n] [--json <file>]");
  return opts;
}

/** One arm: the feature switched off (A) or on (B), whatever its default. */
function runArm(project, outDir, feature, enabled) {
  const env = { ...process.env };
  delete env.CLARIFYDOC_FEATURES;
  const args = [cli, "analyze", project, "-o", outDir, "--no-lsp", "--no-git-history", "--stable-output", "--no-pretty"];
  args.push("--feature", enabled ? feature : `no-${feature}`);
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { env, encoding: "utf8", maxBuffer: 1 << 28 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`analyze ${enabled ? "B" : "A"} failed:\n${r.stderr || r.stdout}`);
  return ms;
}

/** The run's own files beside the per-file analyses. */
const TOP_LEVEL = new Set(["project-summary.json", "report-data.json", "manifest.json"]);

/** Every per-file analysis under an output directory, by its file path. */
function fileAnalyses(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json") && !(d === dir && TOP_LEVEL.has(name))) {
        const a = JSON.parse(readFileSync(p, "utf8"));
        if (typeof a.filePath === "string" && Array.isArray(a.functions)) out.set(a.filePath, a);
      }
    }
  };
  walk(dir);
  return out;
}

/** Functions of a file, methods included, keyed `name@line`. */
function functionsOf(a) {
  const fns = new Map();
  for (const f of a.functions ?? []) fns.set(`${f.name}@${f.line}`, f);
  for (const c of a.classes ?? []) for (const m of c.methods ?? []) fns.set(`${c.name}.${m.name}@${m.line}`, m);
  return fns;
}

function sourceLine(project, file, line) {
  try {
    return (readFileSync(join(project, file), "utf8").split(/\r?\n/)[line - 1] ?? "").trim().slice(0, 140);
  } catch {
    return "";
  }
}

class Samples {
  constructor(limit) {
    this.limit = limit;
    this.kinds = new Map();
  }
  add(kind, sample) {
    const list = this.kinds.get(kind) ?? [];
    if (list.length < this.limit) list.push(sample);
    this.kinds.set(kind, list);
  }
}

function linkKeys(summary) {
  const el = summary.elements ?? [];
  const keys = new Map();
  for (const l of summary.symbolLinks ?? []) {
    const id = (ref) => (typeof ref === "number" ? el[ref]?.id ?? el[ref] : ref);
    const from = id(l.from);
    const to = id(l.to);
    keys.set(`${from} -> ${to} (${l.callName ?? l.relation})`, { from: String(from), to: String(to), call: l.callName ?? l.relation });
  }
  return keys;
}

function sizes(summary) {
  const out = {};
  for (const [k, v] of Object.entries(summary)) {
    if (Array.isArray(v)) out[k] = v.length;
    else if (v && typeof v === "object" && !["provenance", "coverage", "healthScore", "confidenceCounts"].includes(k)) out[k] = Object.keys(v).length;
  }
  return out;
}

function compare(project, dirA, dirB, examples) {
  const A = fileAnalyses(dirA);
  const B = fileAnalyses(dirB);
  const samples = new Samples(examples);
  const perLanguage = {};
  const lang = (l) => (perLanguage[l] ??= {
    files: 0, parsed: 0, fallbackSyntax: 0, fallbackError: 0,
    fnBoth: 0, fnOnlyA: 0, fnOnlyB: 0, spanSame: 0, spanDiffer: 0, spanOneLine: 0,
    callsBoth: 0, callsOnlyA: 0, callsOnlyB: 0, fnCallsSame: 0,
  });
  for (const [file, b] of B) {
    const a = A.get(file);
    if (!a || !b.frontEnd) continue;
    const s = lang(b.language);
    s.files++;
    if (b.frontEnd.fallback === "syntax-errors") {
      s.fallbackSyntax++;
      samples.add(`${b.language}: kept the regex reading (syntax errors)`, `${file} (${b.frontEnd.syntaxErrors})`);
      continue;
    }
    if (b.frontEnd.fallback) {
      s.fallbackError++;
      samples.add(`${b.language}: kept the regex reading (reader failed)`, file);
      continue;
    }
    s.parsed++;
    const fa = functionsOf(a);
    const fb = functionsOf(b);
    for (const [key, f] of fa) {
      if (!fb.has(key)) {
        s.fnOnlyA++;
        samples.add(`${b.language}: function only A finds`, `${file}:${f.line} ${f.name} | ${sourceLine(project, file, f.line)}`);
      }
    }
    for (const [key, g] of fb) {
      const f = fa.get(key);
      if (!f) {
        s.fnOnlyB++;
        samples.add(`${b.language}: function only B finds`, `${file}:${g.line} ${g.name} | ${sourceLine(project, file, g.line)}`);
        continue;
      }
      s.fnBoth++;
      if (f.endLine === g.endLine) s.spanSame++;
      else if (Math.abs(g.endLine - f.endLine) === 1) {
        // One line apart: whether a block's closing line (`}`, `end`) belongs to it.
        s.spanOneLine++;
        samples.add(`${b.language}: span one line apart (A end vs B end)`, `${file}:${f.line} ${f.name} ends A ${f.endLine} / B ${g.endLine} | B: ${sourceLine(project, file, g.endLine)}`);
      } else {
        s.spanDiffer++;
        samples.add(`${b.language}: span differs (A end vs B end)`, `${file}:${f.line} ${f.name} ends A ${f.endLine} / B ${g.endLine} | A: ${sourceLine(project, file, f.endLine)} | B: ${sourceLine(project, file, g.endLine)}`);
      }
      const ca = new Map((f.calls ?? []).map((c) => [c.name, c]));
      const cb = new Map((g.calls ?? []).map((c) => [c.name, c]));
      let same = true;
      for (const [name, c] of ca) {
        if (cb.has(name)) s.callsBoth++;
        else {
          s.callsOnlyA++;
          same = false;
          samples.add(`${b.language}: call only A records`, `${file}:${c.line} ${name} in ${f.name} | ${sourceLine(project, file, c.line)}`);
        }
      }
      for (const [name, c] of cb) {
        if (!ca.has(name)) {
          s.callsOnlyB++;
          same = false;
          samples.add(`${b.language}: call only B records`, `${file}:${c.line} ${name} in ${g.name} | ${sourceLine(project, file, c.line)}`);
        }
      }
      if (same) s.fnCallsSame++;
    }
  }

  const sa = JSON.parse(readFileSync(join(dirA, "project-summary.json"), "utf8"));
  const sb = JSON.parse(readFileSync(join(dirB, "project-summary.json"), "utf8"));
  const la = linkKeys(sa);
  const lb = linkKeys(sb);
  const lostAll = [...la.keys()].filter((k) => !lb.has(k));
  const gainedAll = [...lb.keys()].filter((k) => !la.has(k));
  // A link whose call and target stay, made from another function of the same file: the call moved to the
  // function B says holds it (`x = function() … end`, a nested function), it was not lost.
  const fileOf = (id) => id.split("::")[0];
  const movedKey = (l) => `${fileOf(l.from)}|${l.to}|${l.call}`;
  const gainedMoves = new Map();
  for (const k of gainedAll) gainedMoves.set(movedKey(lb.get(k)), (gainedMoves.get(movedKey(lb.get(k))) ?? 0) + 1);
  const moved = [];
  const lost = [];
  for (const k of lostAll) {
    const key = movedKey(la.get(k));
    if ((gainedMoves.get(key) ?? 0) > 0) {
      gainedMoves.set(key, gainedMoves.get(key) - 1);
      moved.push(k);
    } else lost.push(k);
  }
  const consumed = new Map();
  for (const k of moved) consumed.set(movedKey(la.get(k)), (consumed.get(movedKey(la.get(k))) ?? 0) + 1);
  const gained = gainedAll.filter((k) => {
    const key = movedKey(lb.get(k));
    const left = consumed.get(key) ?? 0;
    if (left === 0) return true;
    consumed.set(key, left - 1);
    return false;
  });
  for (const k of moved.slice(0, examples)) samples.add("link moved to another function of its file", k);
  for (const k of lost.slice(0, examples)) samples.add("link only A makes", k);
  for (const k of gained.slice(0, examples)) samples.add("link only B makes", k);
  const sizeA = sizes(sa);
  const sizeB = sizes(sb);
  const changedSizes = Object.keys({ ...sizeA, ...sizeB })
    .filter((k) => sizeA[k] !== sizeB[k])
    .map((k) => ({ field: k, a: sizeA[k] ?? 0, b: sizeB[k] ?? 0 }));
  return { perLanguage, links: { a: la.size, b: lb.size, lost: lost.length, gained: gained.length, moved: moved.length }, changedSizes, samples: Object.fromEntries(samples.kinds) };
}

const pct = (n, d) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

function report(project, feature, timing, result) {
  const lines = [`# A/B: \`${feature}\` on ${basename(project)}`, ""];
  if (timing) lines.push(`Wall time: A ${(timing.a / 1000).toFixed(1)} s, B ${(timing.b / 1000).toFixed(1)} s (${timing.b >= timing.a ? "+" : ""}${pct(timing.b - timing.a, timing.a)}).`, "");
  lines.push("| language | files | B read | kept regex | functions both | only A | only B | same span | span ±1 line | calls both | only A | only B | functions with same calls |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [l, s] of Object.entries(result.perLanguage)) {
    lines.push(`| ${l} | ${s.files} | ${s.parsed} | ${s.fallbackSyntax + s.fallbackError} | ${s.fnBoth} | ${s.fnOnlyA} | ${s.fnOnlyB} | ${pct(s.spanSame, s.fnBoth)} | ${pct(s.spanOneLine, s.fnBoth)} | ${s.callsBoth} | ${s.callsOnlyA} | ${s.callsOnlyB} | ${pct(s.fnCallsSame, s.fnBoth)} |`);
  }
  lines.push("", `Call→definition links: A ${result.links.a}, B ${result.links.b} (${result.links.gained} only B, ${result.links.lost} only A, ${result.links.moved} moved to another function of the same file).`, "");
  if (result.changedSizes.length > 0) {
    lines.push("Results that changed size:", "", "| field | A | B |", "|---|---|---|");
    for (const c of result.changedSizes) lines.push(`| ${c.field} | ${c.a} | ${c.b} |`);
    lines.push("");
  }
  for (const [kind, list] of Object.entries(result.samples)) {
    lines.push(`## ${kind}`, "");
    for (const s of list) lines.push(`- ${s.replace(/\|/g, "¦")}`);
    lines.push("");
  }
  return lines.join("\n");
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(cli)) throw new Error("dist/cli.js is missing: run `npm run build` first");
const project = resolve(opts.project);
const out = resolve(opts.out ?? mkdtempSync(join(tmpdir(), "clarifydoc-ab-")));
const name = basename(project);
const reuse = opts.reuse && existsSync(join(out, "A", name, "project-summary.json")) && existsSync(join(out, "B", name, "project-summary.json"));
const timing = reuse ? null : { a: runArm(project, join(out, "A"), opts.feature, false), b: runArm(project, join(out, "B"), opts.feature, true) };
const result = compare(project, join(out, "A", name), join(out, "B", name), opts.examples);
console.log(report(project, opts.feature, timing, result));
console.log(`\n(outputs in ${out})`);
if (opts.json) writeFileSync(opts.json, JSON.stringify({ project: name, feature: opts.feature, timing, ...result }, null, 2));
