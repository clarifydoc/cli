import { EXTENSION_TO_LANGUAGE, manifestFor } from "../extractors/registry.js";
import type { TestTarget } from "../types/language-plugin.js";
import { ownersOf } from "./code-owners.js";
import { describeSignatureChange, reverseSymbolReach, type ChangedSymbol, type SignatureChange, type SymbolCaller } from "./changed-symbols.js";
import type {
  Language,
  ProjectAnalysis,
  RiskVerdict,
  TraceImpactRoute,
  TraceImpactScreen,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * Diff-scoped impact: project a set of CHANGED FILES onto the cross-tier
 * blast data — which screens and API routes depend on the change, which
 * entities/queues sit downstream of it, which files (and tests) import it,
 * and a few sample dependency chains for the narrative.
 *
 * Pure consumer of an analyzed summary: the per-file `traceImpact`
 * (trace-impact.ts) and the blast dependents lists are unioned over the
 * changed set — no graph traversal is repeated here except the short
 * reverse-import walk that produces the sample chains. Because the per-file
 * traceImpact lists are capped, a union can undercount; `truncated` is set
 * whenever a contributing list was capped, making the counts lower bounds.
 *
 * Consumers: the `clarifydoc impact` CLI command (git-diff driven), the
 * analyzer's `impact-latest.json` artifact on incremental runs (served by the
 * application server and rendered by the viewer's Overview card).
 */

export interface ImpactDiffResult {
  generatedAt: string;
  /** How the changed set was obtained, for display ("HEAD", "--staged", "manifest", …). */
  baseLabel: string;
  /** Changed files present in the analysis (canonical files[] paths). */
  changedFiles: string[];
  /** Changed paths the analysis doesn't know (new/unanalyzed/non-source). */
  unknownFiles: string[];
  /** Files deleted since the previous analysis run, when known. */
  removedFiles: string[];
  screens: TraceImpactScreen[];
  screenCount: number;
  routes: TraceImpactRoute[];
  routeCount: number;
  entities: string[];
  entityCount: number;
  queues: string[];
  queueCount: number;
  /** True when any contributing capped list overflowed — counts are lower bounds. */
  truncated: boolean;
  /** Files that (transitively) import a changed file, excluding the changed set. */
  dependents: string[];
  dependentCount: number;
  /** Test files among changed ∪ dependents — the "tests to run" set. */
  tests: string[];
  testCount: number;
  /**
   * The test functions that call a changed function, directly or through
   * others (with the diff's lines only) — the tests that exercise the change,
   * not just the ones that import its file.
   */
  testCallers?: Array<{ file: string; symbol: string; line: number; depth: number }>;
  /** Commands that run the tests, per language, by its plugin's runner (`pytest a.py::test_x`, `go test ./pkg -run …`). */
  testCommands?: Array<{ language: string; command: string }>;
  /** Sample reverse-import chains: changed file → … → screen/route file. */
  chains: Array<{ path: string[]; endsAt: "screen" | "route" }>;
  /**
   * Files history changes together with a changed file, that this change
   * leaves out — "usually changed with": the strongest first, at most ten.
   * Absent without git history.
   */
  missingCoChanges?: Array<{ file: string; with: string; count: number; score: number; hidden?: boolean }>;
  /**
   * What the change touches that no test runs, by the analysis's coverage
   * reports: the changed functions (or, without the diff's lines, the changed
   * files) with counted lines and none run. Absent without a coverage report.
   */
  untested?: Array<{ file: string; symbol?: string; line?: number; lines: number }>;
  /** CODEOWNERS owners of the changed files, with how many changed files each owns. */
  owners?: Array<{ owner: string; files: number }>;
  /**
   * Who knows the changed files best: their authors by commits to them,
   * the change's own author left out. At most three. Absent without history.
   */
  reviewers?: Array<{ name: string; files: number; commits: number }>;
  /**
   * The change at the level of functions, when the diff's lines were known:
   * the functions and methods it touched, their callers (direct, and 2–4
   * hops away with the weakest-link confidence), the API routes and screens
   * those callers belong to, and the files that import a changed file
   * without calling a changed function — read them, nothing breaks there
   * by call. Files changed outside any function are in `moduleLevel`, where
   * the file-level impact above is the answer.
   */
  symbolImpact?: {
    changed: ChangedSymbol[];
    moduleLevel: string[];
    direct: SymbolCaller[];
    transitive: SymbolCaller[];
    routes: Array<{ route: string; file: string; line: number; depth: number; confidence: string }>;
    screens: Array<{ name: string; file: string; depth: number }>;
    reviewOnly: string[];
    /** Functions removed or re-parameterized, and whether the change breaks their callers. */
    signatureChanges?: SignatureChange[];
  };
  risk: { level: "low" | "moderate" | "high"; reasons: string[] };
}

const DEP_LIST_CAP = 100;
const CHAIN_CAP = 5;
const CHAIN_DEPTH = 5;

/** Normalize a user/git-supplied path to the analysis files[] shape. */
function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * Work out what a set of changed files reaches: dependent files (via the
 * reversed component graph), the screens and API routes at the end of those
 * chains, the entities and queues touched, the tests that cover them, and a
 * risk level with its reasons.
 *
 * Paths are matched to the analysis exactly, then case-insensitively; files
 * the analysis does not know are reported as `unknownFiles`. Lists are capped
 * and `truncated` says so; counts stay exact.
 *
 * @param summary - A loaded `project-summary.json`
 * @param changed - Changed paths, as git or the user spells them
 * @param options - Removed paths, and a label for the base being compared
 * @returns The impact report `renderImpactText`/`renderImpactMarkdown` print
 */
export function computeImpactDiff(
  summary: ProjectAnalysis,
  changed: string[],
  options?: {
    removedFiles?: string[];
    baseLabel?: string;
    author?: string;
    /** The changed functions (from `symbolsInHunks`), when the diff's lines are known. */
    symbols?: { changed: ChangedSymbol[]; moduleLevel: string[]; signatureChanges?: SignatureChange[] };
  },
): ImpactDiffResult {
  // Canonical path index — exact first, case-insensitive fallback (Delphi
  // corpora drift between UNIT1.PAS and Unit1.pas across git and disk).
  const canonical = new Map<string, string>();
  const lower = new Map<string, string>();
  for (const f of summary.files) {
    canonical.set(f, f);
    if (!lower.has(f.toLowerCase())) lower.set(f.toLowerCase(), f);
  }

  const changedFiles: string[] = [];
  const unknownFiles: string[] = [];
  const changedSet = new Set<string>();
  for (const raw of changed) {
    const n = normalizePath(raw);
    const hit = canonical.get(n) ?? lower.get(n.toLowerCase());
    if (hit) {
      if (!changedSet.has(hit)) {
        changedSet.add(hit);
        changedFiles.push(hit);
      }
    } else {
      unknownFiles.push(n);
    }
  }
  changedFiles.sort();
  unknownFiles.sort();

  const blastByFile = new Map(
    (summary.blastRadius ?? []).map((b) => [b.filePath, b]),
  );

  // ── Union the cross-tier reach of every changed file ──
  const screens = new Map<string, TraceImpactScreen>();
  const routes = new Map<string, TraceImpactRoute>();
  const entities = new Set<string>();
  const queues = new Set<string>();
  const dependents = new Set<string>();
  let truncated = false;
  let dangerous: string | null = null;
  let moderate: string | null = null;
  // The most severe verdict among the changed files. "you touched a foundation
  // type reached by 4 screens" is the sentence a reviewer acts on; the counts
  // below are what back it up.
  let topVerdict: { file: string; verdict: RiskVerdict } | null = null;
  const VERDICT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

  for (const file of changedFiles) {
    const b = blastByFile.get(file);
    if (!b) continue;
    if (b.changeRisk === "dangerous" && !dangerous) dangerous = file;
    if (b.changeRisk === "moderate" && !moderate) moderate = file;
    if (b.verdict && b.verdict.category !== "unknown") {
      const rank = VERDICT_RANK[b.verdict.level] ?? 0;
      if (!topVerdict || rank > (VERDICT_RANK[topVerdict.verdict.level] ?? 0)) {
        topVerdict = { file, verdict: b.verdict };
      }
    }
    // The stored blast lists are CAPPED on hub-dense repos (counts stay exact),
    // so on monsters the dependent union is a lower bound — same contract as
    // the traceImpact `truncated` flag below.
    for (const f of b.affectedFiles) dependents.add(f);
    for (const f of b.transitiveFiles) dependents.add(f);
    const t = b.traceImpact;
    if (!t) continue;
    for (const s of t.screens) screens.set(s.file, s);
    for (const r of t.routes) routes.set(`${r.method ?? ""} ${r.path} ${r.file}`, r);
    for (const e of t.entities) entities.add(e);
    for (const q of t.queues) queues.add(q);
    truncated ||=
      t.screenCount > t.screens.length ||
      t.routeCount > t.routes.length ||
      t.entityCount > t.entities.length ||
      t.queueCount > t.queues.length;
  }
  for (const f of changedSet) dependents.delete(f);

  // ── Tests to run: test files among changed ∪ dependents ──
  const tests = [...new Set([...changedSet, ...dependents])]
    // The summary's layer map is language-aware; the bare check stays as the
    // fallback for summaries written before it was.
    .filter((f) => summary.fileLayerMap?.[f] === "test" || isTestFile(f))
    .sort();

  // ── Sample chains: reverse-import BFS from changed files to a screen/route file ──
  const reverseGraph = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(summary.componentGraph ?? {})) {
    for (const t of targets) {
      let arr = reverseGraph.get(t);
      if (!arr) reverseGraph.set(t, (arr = []));
      arr.push(source);
    }
  }
  const screenFiles = new Set((summary.screens ?? []).map((s) => s.filePath));
  const routeFiles = new Set(
    (summary.routeMap ?? [])
      .filter((r) => r.kind === "api")
      .map((r) => (r as { filePath?: string }).filePath)
      .filter((f): f is string => !!f),
  );
  const chains: ImpactDiffResult["chains"] = [];
  for (const start of changedFiles) {
    if (chains.length >= CHAIN_CAP) break;
    // The changed file itself being a screen/route file is trivially visible
    // in the screens/routes lists — chains are for the non-obvious paths.
    const parent = new Map<string, string>();
    const visited = new Set([start]);
    let frontier = [start];
    let found: { file: string; endsAt: "screen" | "route" } | null = null;
    for (let depth = 0; depth < CHAIN_DEPTH && frontier.length > 0 && !found; depth++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const dep of reverseGraph.get(f) ?? []) {
          if (visited.has(dep)) continue;
          visited.add(dep);
          parent.set(dep, f);
          if (screenFiles.has(dep)) { found = { file: dep, endsAt: "screen" }; break; }
          if (routeFiles.has(dep)) { found = { file: dep, endsAt: "route" }; break; }
          next.push(dep);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (found) {
      const path: string[] = [found.file];
      let cur: string | undefined = found.file;
      while (cur && cur !== start) {
        cur = parent.get(cur);
        if (cur) path.push(cur);
      }
      chains.push({ path: path.reverse(), endsAt: found.endsAt });
    }
  }

  // ── Usually changed together, left out of this change ──
  const missing = new Map<string, NonNullable<ImpactDiffResult["missingCoChanges"]>[number]>();
  for (const p of summary.coChange ?? []) {
    const inA = changedSet.has(p.a);
    const inB = changedSet.has(p.b);
    if (inA === inB) continue;
    const file = inA ? p.b : p.a;
    const prev = missing.get(file);
    if (!prev || p.score > prev.score) missing.set(file, { file, with: inA ? p.a : p.b, count: p.count, score: p.score, ...(p.hidden ? { hidden: true } : {}) });
  }
  const missingCoChanges = [...missing.values()].sort((x, y) => y.score - x.score || y.count - x.count || byOrdinal(x.file, y.file)).slice(0, 10);

  // ── Function-level: callers of what changed ──
  let symbolImpact: ImpactDiffResult["symbolImpact"];
  if (options?.symbols) {
    const callers = reverseSymbolReach(summary.symbolLinks ?? [], options.symbols.changed);
    const screenByFile = new Map((summary.screens ?? []).map((s) => [s.filePath, s.name]));
    const routes = callers.filter((c) => c.symbol.startsWith("route:")).map((c) => ({ route: c.symbol.slice("route:".length), file: c.file, line: c.line, depth: c.depth, confidence: c.confidence }));
    const screenSeen = new Map<string, { name: string; file: string; depth: number }>();
    for (const c of [...options.symbols.changed.map((s) => ({ file: s.file, depth: 0 })), ...callers]) {
      const name = screenByFile.get(c.file);
      if (name && !screenSeen.has(c.file)) screenSeen.set(c.file, { name, file: c.file, depth: c.depth });
    }
    const callerFiles = new Set(callers.map((c) => c.file));
    const symbolFiles = new Set(options.symbols.changed.map((s) => s.file));
    const reviewOnly = [...new Set(Object.entries(summary.componentGraph ?? {})
      .filter(([from, deps]) => !symbolFiles.has(from) && !callerFiles.has(from) && deps.some((d) => symbolFiles.has(d)))
      .map(([from]) => from))].sort(byOrdinal);
    const nonRoute = callers.filter((c) => !c.symbol.startsWith("route:"));
    standCallers(summary, options.symbols.changed, nonRoute.filter((c) => c.depth === 1).slice(0, 50).concat(nonRoute.filter((c) => c.depth > 1).slice(0, 50)));
    symbolImpact = {
      changed: options.symbols.changed,
      moduleLevel: options.symbols.moduleLevel,
      direct: nonRoute.filter((c) => c.depth === 1).slice(0, 50),
      transitive: nonRoute.filter((c) => c.depth > 1).slice(0, 50),
      routes: routes.slice(0, 50),
      screens: [...screenSeen.values()].sort((a, b) => a.depth - b.depth || byOrdinal(a.name, b.name)),
      reviewOnly: reviewOnly.slice(0, DEP_LIST_CAP),
      ...(options.symbols.signatureChanges?.length ? { signatureChanges: options.symbols.signatureChanges } : {}),
    };
  }

  // ── The tests that exercise the change, and how to run them ──
  const testCallers = options?.symbols
    ? reverseSymbolReach(summary.symbolLinks ?? [], options.symbols.changed, 6)
        .filter((c) => !c.symbol.startsWith("route:") && (summary.fileLayerMap?.[c.file] === "test" || isTestFile(c.file)))
        .map((c) => ({ file: c.file, symbol: c.symbol, line: c.line, depth: c.depth }))
        .sort((a, b) => a.depth - b.depth || byOrdinal(a.file, b.file) || a.line - b.line)
    : [];
  const targets = new Map<string, Set<string>>();
  for (const t of testCallers.length ? testCallers : tests.map((file) => ({ file, symbol: "" }))) {
    const names = targets.get(t.file) ?? targets.set(t.file, new Set()).get(t.file)!;
    if (t.symbol) names.add(t.symbol);
  }
  const testCommands = testCommandsFor(summary, [...targets].map(([file, names]) => ({ file, names: [...names] })));

  // ── What no test runs, by the coverage reports ──
  let untested: ImpactDiffResult["untested"];
  if (summary.testCoverage) {
    const cov = new Map(summary.testCoverage.files.map((f) => [f.file, f]));
    untested = [];
    if (options?.symbols?.changed.length) {
      for (const s of options.symbols.changed) {
        const fn = cov.get(s.file)?.functions?.find((f) => f.line === s.line || (s.line >= f.line && s.endLine <= f.endLine && f.name.endsWith(s.symbol.split(".").pop()!)));
        if (fn && fn.total > 0 && fn.covered === 0) untested.push({ file: s.file, symbol: s.symbol, line: s.line, lines: fn.total });
      }
    } else {
      for (const f of changedFiles) {
        const c = cov.get(f);
        if (c && c.total > 0 && c.covered === 0) untested.push({ file: f, lines: c.total });
      }
    }
  }

  // ── Owners and reviewers ──
  const ownerFiles = new Map<string, number>();
  for (const f of changedFiles) {
    for (const o of summary.codeOwners ? ownersOf(summary.codeOwners.rules, f) : []) ownerFiles.set(o, (ownerFiles.get(o) ?? 0) + 1);
  }
  const owners = [...ownerFiles.entries()].map(([owner, files]) => ({ owner, files })).sort((a, b) => b.files - a.files || byOrdinal(a.owner, b.owner));
  const self = options?.author?.trim().toLowerCase();
  const byAuthor = new Map<string, { name: string; files: number; commits: number }>();
  const churnOf = new Map((summary.fileChurn ?? []).map((c) => [c.file, c]));
  for (const f of changedFiles) {
    for (const s of churnOf.get(f)?.authorShares ?? []) {
      if (self && s.name.trim().toLowerCase() === self) continue;
      const key = s.name.toLowerCase();
      const acc = byAuthor.get(key) ?? byAuthor.set(key, { name: s.name, files: 0, commits: 0 }).get(key)!;
      acc.files++;
      acc.commits += s.commits;
    }
  }
  const reviewers = [...byAuthor.values()].sort((a, b) => b.commits - a.commits || b.files - a.files || byOrdinal(a.name, b.name)).slice(0, 3);

  // ── Risk rollup ──
  const reasons: string[] = [];
  if (topVerdict) {
    reasons.push(
      `${topVerdict.file} is a ${topVerdict.verdict.category} file (${topVerdict.verdict.level} impact)`,
    );
  }
  if (dangerous) reasons.push(`${dangerous} is dangerous to change`);
  else if (moderate) reasons.push(`${moderate} is moderate to change`);
  if (screens.size > 0) reasons.push(`reaches ${screens.size} screen(s)`);
  if (routes.size > 0) reasons.push(`affects ${routes.size} API route(s)`);
  if (entities.size > 0) reasons.push(`touches ${[...entities].slice(0, 5).join(", ")}`);
  if (queues.size > 0) reasons.push(`involves queue(s) ${[...queues].slice(0, 3).join(", ")}`);
  if (tests.length === 0 && dependents.size >= 3) {
    reasons.push(`no test files among ${dependents.size} dependents`);
  }
  if (untested?.length) reasons.push(`no test runs ${untested.length === 1 ? (untested[0]!.symbol ?? untested[0]!.file) : `${untested.length} of the changed ${untested[0]!.symbol ? "functions" : "files"}`}`);
  const breaking = symbolImpact?.signatureChanges?.filter((c) => c.breaking) ?? [];
  if (breaking.length > 0) {
    reasons.push(`breaks the callers of ${breaking.slice(0, 3).map((c) => `${c.symbol} (${describeSignatureChange(c)})`).join(", ")}`);
  }
  const strongMissing = missingCoChanges.filter((m) => m.score >= 0.6);
  if (strongMissing.length > 0) {
    reasons.push(`leaves out ${strongMissing.length} file(s) usually changed with it (${strongMissing.slice(0, 2).map((m) => m.file).join(", ")})`);
  }
  let level: ImpactDiffResult["risk"]["level"] = "low";
  if (breaking.length > 0 || dangerous || screens.size >= 8 || (screens.size >= 1 && entities.size >= 3)) {
    level = "high";
  } else if (moderate || screens.size >= 1 || entities.size >= 1 || dependents.size >= 3) {
    level = "moderate";
  }

  const sortedDependents = [...dependents].sort();
  const result: ImpactDiffResult = {
    generatedAt: new Date().toISOString(),
    baseLabel: options?.baseLabel ?? "manifest",
    changedFiles,
    unknownFiles,
    removedFiles: (options?.removedFiles ?? []).map(normalizePath).sort(),
    screens: [...screens.values()].sort((a, b) => byOrdinal(a.name, b.name)),
    screenCount: screens.size,
    routes: [...routes.values()].sort((a, b) => byOrdinal(a.path, b.path)),
    routeCount: routes.size,
    entities: [...entities].sort(),
    entityCount: entities.size,
    queues: [...queues].sort(),
    queueCount: queues.size,
    truncated,
    dependents: sortedDependents.slice(0, DEP_LIST_CAP),
    dependentCount: dependents.size,
    tests,
    testCount: tests.length,
    chains,
    ...(missingCoChanges.length > 0 ? { missingCoChanges } : {}),
    ...(owners.length > 0 ? { owners } : {}),
    ...(symbolImpact ? { symbolImpact } : {}),
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(untested?.length ? { untested } : {}),
    ...(testCallers.length ? { testCallers: testCallers.slice(0, 50) } : {}),
    ...(testCommands.length ? { testCommands } : {}),
    risk: { level, reasons },
  };
  return result;
}

// ─── Renderers (CLI output) ─────────────────────────────────────────────────

const geq = (r: ImpactDiffResult): string => (r.truncated ? "≥" : "");

/** Chains read UI-first: screen/route file → … → changed file. */
function chainLine(c: ImpactDiffResult["chains"][number]): string {
  return `${[...c.path].reverse().join(" → ")}  [${c.endsAt}]`;
}

/** Render an impact report as plain text for the terminal. */
export function renderImpactText(r: ImpactDiffResult): string {
  const lines: string[] = [];
  lines.push(`Impact of ${r.changedFiles.length} changed file(s)  [base: ${r.baseLabel}]`);
  lines.push(`Risk: ${r.risk.level.toUpperCase()}${r.risk.reasons.length ? " — " + r.risk.reasons.join("; ") : ""}`);
  lines.push("");
  if (r.changedFiles.length) lines.push(`Changed:  ${r.changedFiles.join(", ")}`);
  if (r.unknownFiles.length) lines.push(`Unknown:  ${r.unknownFiles.join(", ")}  (not in the analysis)`);
  if (r.removedFiles.length) lines.push(`Removed:  ${r.removedFiles.join(", ")}`);
  if (r.screenCount > 0) {
    lines.push("", `Screens reached (${geq(r)}${r.screenCount}):`);
    for (const s of r.screens) lines.push(`  ${s.name}${s.route ? `  ${s.route}` : ""}  (${s.file})`);
  }
  if (r.routeCount > 0) {
    lines.push("", `API routes reached (${geq(r)}${r.routeCount}):`);
    for (const rt of r.routes) lines.push(`  ${rt.method ?? "ANY"} ${rt.path}  (${rt.file}:${rt.line})`);
  }
  if (r.entityCount > 0) lines.push("", `Data touched (${geq(r)}${r.entityCount}): ${r.entities.join(", ")}`);
  if (r.queueCount > 0) lines.push(`Queues (${geq(r)}${r.queueCount}): ${r.queues.join(", ")}`);
  if (r.testCount > 0) {
    lines.push("", `Tests to run (${r.testCount}):`);
    for (const t of r.tests) lines.push(`  ${t}`);
    if (r.testCallers?.length) {
      lines.push("", `Tests that call the changed functions (${r.testCallers.length}):`);
      for (const t of r.testCallers.slice(0, 20)) lines.push(`  ${t.symbol} (${t.file}:${t.line})${t.depth > 1 ? ` — ${t.depth} calls away` : ""}`);
    }
    for (const c of r.testCommands ?? []) lines.push(`  run: ${c.command}`);
    if (r.untested?.length) {
      lines.push("", `Untested — no test runs these (${r.untested.length}):`);
      for (const u of r.untested) lines.push(`  ${u.symbol ? `${u.symbol} (${u.file}:${u.line})` : u.file}`);
    }
  }
  if (r.missingCoChanges?.length) {
    lines.push("", "Usually changed with, not in this change:");
    for (const m of r.missingCoChanges) lines.push(`  ${m.file}  — with ${m.with} in ${m.count} commits (${Math.round(m.score * 100)}%)${m.hidden ? ", no import joins them" : ""}`);
  }
  if (r.symbolImpact) {
    const si = r.symbolImpact;
    lines.push("", `Changed functions (${si.changed.length}):`);
    for (const s of si.changed) lines.push(`  ${s.symbol}  (${s.file}:${s.line})`);
    if (si.moduleLevel.length) lines.push(`  outside any function: ${si.moduleLevel.join(", ")}`);
    if (si.routes.length) {
      lines.push("", `Routes whose handlers reach them (${si.routes.length}):`);
      for (const rt of si.routes) lines.push(`  ${rt.route}  (${rt.file}:${rt.line}, ${rt.depth} hop${rt.depth === 1 ? "" : "s"}, ${rt.confidence.toLowerCase()})`);
    }
    if (si.direct.length) {
      lines.push("", `Direct callers (${si.direct.length}${si.direct.some((c) => c.standing) ? `: ${standingCounts(si.direct)}` : ""}):`);
      // Unverified first: those are the ones to read.
      const order = { unverified: 0, covered: 1, updated: 2, test: 3 } as const;
      for (const c of [...si.direct].sort((a, b) => (order[a.standing ?? "unverified"] - order[b.standing ?? "unverified"]))) {
        const note = c.standing ? ` — ${c.standing === "covered" && c.coveredBy ? `covered by ${c.coveredBy.symbol}` : STANDING_NOTE[c.standing]}` : "";
        lines.push(`  ${c.symbol}  (${c.file}:${c.line}, ${c.confidence.toLowerCase()})${note}`);
      }
    }
    if (si.transitive.length) lines.push(`Callers 2–4 hops away: ${si.transitive.length}${si.transitive.some((c) => c.standing) ? ` (${standingCounts(si.transitive)})` : ""}`);
    if (si.reviewOnly.length) lines.push(`Import a changed file but call nothing changed: ${si.reviewOnly.join(", ")}`);
    if (si.signatureChanges?.length) {
      lines.push("", "Signature changes:");
      for (const c of si.signatureChanges) {
        const what = describeSignatureChange(c);
        lines.push(`  ${c.breaking ? "BREAKING " : ""}${c.symbol}  ${what}; ${c.callers} certain caller(s)  (${c.file}:${c.line})`);
      }
    }
  }
  if (r.owners?.length) lines.push("", `Owners (CODEOWNERS): ${r.owners.map((o) => `${o.owner} (${o.files})`).join(", ")}`);
  if (r.reviewers?.length) lines.push(`Suggested reviewers: ${r.reviewers.map((x) => `${x.name} (${x.commits} commits to ${x.files} of these files)`).join(", ")}`);
  lines.push("", `Dependent files: ${r.dependentCount}`);
  if (r.chains.length > 0) {
    lines.push("", "Chains:");
    for (const c of r.chains) lines.push(`  ${chainLine(c)}`);
  }
  return lines.join("\n");
}

/** Render an impact report as GitHub-flavoured Markdown, for a PR comment. */
export function renderImpactMarkdown(r: ImpactDiffResult): string {
  const md: string[] = [];
  md.push(`### ClarifyDoc impact — **${r.risk.level.toUpperCase()}** risk`);
  md.push("");
  md.push(
    `**${r.changedFiles.length} changed file(s)** (base: ${r.baseLabel})` +
      (r.risk.reasons.length ? ` — ${r.risk.reasons.join("; ")}` : ""),
  );
  md.push("");
  const row = (label: string, value: string) => md.push(`| ${label} | ${value} |`);
  md.push("| | |");
  md.push("|---|---|");
  row("Changed", r.changedFiles.map((f) => `\`${f}\``).join(", ") || "—");
  if (r.unknownFiles.length) row("Unknown", r.unknownFiles.map((f) => `\`${f}\``).join(", "));
  if (r.removedFiles.length) row("Removed", r.removedFiles.map((f) => `\`${f}\``).join(", "));
  row(
    `Screens (${geq(r)}${r.screenCount})`,
    r.screens.map((s) => `${s.name}${s.route ? ` (\`${s.route}\`)` : ""}`).join(", ") || "—",
  );
  row(
    `API routes (${geq(r)}${r.routeCount})`,
    r.routes.map((rt) => `\`${rt.method ?? "ANY"} ${rt.path}\``).join(", ") || "—",
  );
  row(`Data (${geq(r)}${r.entityCount})`, r.entities.map((e) => `\`${e}\``).join(", ") || "—");
  if (r.queueCount > 0) row(`Queues (${geq(r)}${r.queueCount})`, r.queues.map((q) => `\`${q}\``).join(", "));
  row(`Tests to run (${r.testCount})`, r.tests.map((t) => `\`${t}\``).join(", ") || "—");
  if (r.testCommands?.length) row("Run", r.testCommands.map((c) => `\`${c.command}\``).join("<br>"));
  if (r.untested?.length) row(`Untested (${r.untested.length})`, r.untested.map((u) => `\`${u.symbol ?? u.file}\``).join(", "));
  if (r.missingCoChanges?.length) {
    row("Usually changed with", r.missingCoChanges.map((m) => `\`${m.file}\` (${Math.round(m.score * 100)}% with \`${m.with}\`)`).join(", "));
  }
  if (r.symbolImpact) {
    const si = r.symbolImpact;
    row(`Changed functions (${si.changed.length})`, si.changed.map((s) => `\`${s.symbol}\``).join(", ") || "—");
    if (si.routes.length) row(`Routes reached by call (${si.routes.length})`, si.routes.map((rt) => `\`${rt.route}\``).join(", "));
    row(`Callers (${si.direct.length} direct, ${si.transitive.length} further)`, si.direct.slice(0, 10).map((c) => `\`${c.symbol}\``).join(", ") || "—");
    const unverified = si.direct.filter((c) => c.standing === "unverified");
    if (si.direct.some((c) => c.standing)) {
      row("Direct callers stand", `${standingCounts(si.direct)}${unverified.length ? ` — check: ${unverified.slice(0, 10).map((c) => `\`${c.symbol}\``).join(", ")}` : ""}`);
    }
    const sig = si.signatureChanges ?? [];
    if (sig.length) row("Signature changes", sig.map((c) => `${c.breaking ? "**breaking** " : ""}\`${c.symbol}\` ${describeSignatureChange(c)} (${c.callers} caller${c.callers === 1 ? "" : "s"})`).join(", "));
  }
  if (r.owners?.length) row("Owners", r.owners.map((o) => `${o.owner} (${o.files})`).join(", "));
  if (r.reviewers?.length) row("Suggested reviewers", r.reviewers.map((x) => `${x.name} (${x.commits} commits)`).join(", "));
  row("Dependents", String(r.dependentCount));
  if (r.chains.length > 0) {
    md.push("");
    md.push("<details><summary>Dependency chains (UI → changed file)</summary>");
    md.push("");
    for (const c of r.chains) md.push(`- ${chainLine(c)}`);
    md.push("");
    md.push("</details>");
  }
  return md.join("\n");
}

/**
 * Consumer standing: for each caller of a changed function, whether the
 * change edits it too (`updated`), a test calls it (nearest test function,
 * up to six calls back) or a coverage report saw its lines run (`covered`),
 * it is a test itself (`test`), or nothing vouches for it (`unverified`) —
 * the callers a reviewer has to check by hand. Sets `standing` in place.
 */
function standCallers(summary: ProjectAnalysis, changed: readonly ChangedSymbol[], callers: SymbolCaller[]): void {
  const edited = new Set(changed.map((c) => `${c.file}::${c.symbol}`));
  const isTest = (f: string) => summary.fileLayerMap?.[f] === "test" || isTestFile(f);
  const cov = new Map((summary.testCoverage?.files ?? []).map((f) => [f.file, f]));
  const ranByCoverage = (c: SymbolCaller): boolean => {
    const name = c.symbol.split(".").pop()!;
    const fn = cov.get(c.file)?.functions?.find((f) => c.line >= f.line && c.line <= f.endLine && f.name.endsWith(name));
    return !!fn && fn.covered > 0;
  };
  const links = summary.symbolLinks ?? [];
  for (const c of callers) {
    if (isTest(c.file)) {
      c.standing = "test";
      continue;
    }
    if (edited.has(`${c.file}::${c.symbol}`)) {
      c.standing = "updated";
      continue;
    }
    const test = reverseSymbolReach(links, [{ file: c.file, symbol: c.symbol, line: c.line, endLine: c.line }], 6)
      .find((t) => !t.symbol.startsWith("route:") && isTest(t.file));
    if (test) {
      c.standing = "covered";
      c.coveredBy = { file: test.file, symbol: test.symbol };
    } else {
      c.standing = ranByCoverage(c) ? "covered" : "unverified";
    }
  }
}

/** "3 updated, 1 covered, 2 unverified" — the callers' standings, worst last. */
function standingCounts(callers: readonly SymbolCaller[]): string {
  const n = (s: SymbolCaller["standing"]) => callers.filter((c) => c.standing === s).length;
  return [["updated", n("updated")], ["covered", n("covered")], ["test", n("test")], ["unverified", n("unverified")]]
    .filter(([, k]) => (k as number) > 0).map(([label, k]) => `${k} ${label === "test" ? "tests" : label}`).join(", ");
}

const STANDING_NOTE: Record<NonNullable<SymbolCaller["standing"]>, string> = {
  updated: "updated in this change",
  covered: "a test covers it",
  test: "a test",
  unverified: "unverified: not updated, no test",
};

/** Each language's command for these tests, from its plugin (`LanguagePluginManifest.testCommand`). */
function testCommandsFor(summary: ProjectAnalysis, tests: readonly TestTarget[]): Array<{ language: string; command: string }> {
  if (!tests.length) return [];
  const ctx = {
    packages: new Set((summary.externalPackages ?? []).map((p) => p.name)),
    manifests: new Set((summary.externalPackages ?? []).map((p) => p.declaredIn.slice(p.declaredIn.lastIndexOf("/") + 1))),
  };
  const byLanguage = new Map<string, TestTarget[]>();
  for (const t of tests) {
    const language = EXTENSION_TO_LANGUAGE[t.file.slice(t.file.lastIndexOf(".")).toLowerCase()];
    if (!language) continue;
    (byLanguage.get(language) ?? byLanguage.set(language, []).get(language)!).push(t);
  }
  const out: Array<{ language: string; command: string }> = [];
  for (const [language, list] of [...byLanguage].sort((a, b) => byOrdinal(a[0], b[0]))) {
    const command = manifestFor(language as Language)?.testCommand?.(list, ctx);
    if (command) out.push({ language, command });
  }
  return out;
}
