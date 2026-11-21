import { EXTENSION_TO_LANGUAGE, manifestFor } from "../extractors/registry.js";
import type { TestTarget } from "../types/language-plugin.js";
import { ownersOf } from "./code-owners.js";
import { describeSignatureChange, signatureChangeTail, reverseSymbolReach, type ChangedClass, type ChangedSymbol, type ClassChange, type SignatureChange, type SymbolCaller } from "./changed-symbols.js";
import { filesImportingNames, filesNaming, namingIndex, type MemberTarget } from "./member-dependents.js";
import type {
  Language,
  ProjectAnalysis,
  RiskVerdict,
  TraceImpactRoute,
  TraceImpactScreen,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { aggregateOnlyNote, perTestSources, rangeLines, testsOfCoverageFunction, type CoverageTest, type TestCoverageReport } from "./test-coverage.js";

/** [3,4,5,9] → "3-5,9". */
function toRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return out.join(",");
}
import { isTestFile } from "./test-file-detector.js";
import { hubFollow, testCodeIndex, testFilterPath } from "./test-functions.js";

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
  /**
   * Files that (transitively) import a changed file, excluding the changed set — or, when the diff's lines
   * say which members changed (`narrowed`), the files that NAME them: call a changed function, or use a
   * changed type in a way the change can break. The rest are `narrowed.importers` of context.
   */
  dependents: string[];
  dependentCount: number;
  /**
   * Set when `dependents` was narrowed to the files naming what changed: how many files import the changed
   * files altogether, the changed files it was judged for, and why each dependent is charged (the first
   * reasons, `DEP_LIST_CAP` files).
   */
  narrowed?: { importers: number; files: string[]; members: Array<{ file: string; name: string; adding?: boolean }>; why: Array<{ file: string; reasons: string[] }> };
  /** Test files among changed ∪ dependents — the "tests to run" set. */
  tests: string[];
  testCount: number;
  /**
   * The test functions that call a changed function, directly or through
   * others (with the diff's lines only) — the tests that exercise the change,
   * not just the ones that import its file.
   */
  testCallers?: Array<{ file: string; symbol: string; line: number; depth: number }>;
  /**
   * The tests a per-test coverage report saw execute a changed function (or,
   * without the diff's lines, any function of a changed file) — measured
   * evidence, ahead of the call graph's `testCallers`. `ran`: the changed
   * functions each ran; `more`: tests beyond those the report kept per
   * function (a lower bound); `from`: the reports that name tests.
   */
  measuredTests?: { tests: Array<CoverageTest & { ran: string[] }>; more: number; from: string[] };
  /** Why there is no measured evidence: the coverage reports are aggregate-only. */
  coverageNote?: string;
  /**
   * What this report could not judge, one sentence each: changed paths the
   * analysis does not know (`unknownFiles`), counts that are lower bounds
   * (`truncated`), no measured test evidence (`coverageNote`). Absent when
   * nothing was left out.
   */
  limitations?: string[];
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
   * Documents that name a changed file — its path, a route it serves or a
   * class it declares (`docDrift.links`): the docs to update. At most 20;
   * `docCount` is the total.
   */
  docs?: Array<{ doc: string; line: number; text: string; file: string }>;
  docCount?: number;
  /**
   * What the change touches that no test runs, by the analysis's coverage
   * reports: the changed functions (or, without the diff's lines, the changed
   * files) with counted lines and none run. Absent without a coverage report.
   */
  untested?: Array<{ file: string; symbol?: string; line?: number; lines: number }>;
  /**
   * The changed lines (the diff's new side) that the coverage report says no
   * test ran, per file — patch coverage, as the lines to look at. Absent
   * without a coverage report or the diff's lines.
   */
  patchCoverage?: { uncoveredLines: number; files: Array<{ file: string; changedLines: number; uncovered: string }> };
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
    symbols?: {
      changed: ChangedSymbol[];
      moduleLevel: string[];
      signatureChanges?: SignatureChange[];
      /** Changed line ranges per file (new side), with the old-side `deleted`/`old` ranges of `ChangedHunks`. */
      hunks?: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> & { old?: ReadonlyMap<string, unknown>; deleted?: ReadonlyMap<string, unknown> };
      /** Types changed outside their methods, judged before and after (`classChanges`). */
      classChanges?: ClassChange[];
      /** Files with a changed line in neither a method nor a type: only the file-level answer holds for them. */
      moduleOnly?: string[];
      /** Files with a changed line inside their import block (what they import, not what they offer). */
      importOnly?: string[];
      /** Of those, the names a file forwards from what it imports (`export { x }`, a Python import): the importers naming one are charged. */
      forwarded?: Record<string, string[]>;
      /** Of the files whose changed lines all fall on module-level names, the files that read those names. */
      boundReaders?: Record<string, string[]>;
    };
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
  // Everything that imports a changed file: the context a narrowed list is read against.
  const importers = new Set<string>();
  // Files reaching a narrowed file's named dependents by imports: where its tests are looked for.
  const reached = new Set<string>();
  let dangerous: string | null = null;
  let moderate: string | null = null;
  // The most severe verdict among the changed files. "you touched a foundation
  // type reached by 4 screens" is the sentence a reviewer acts on; the counts
  // below are what back it up.
  let topVerdict: { file: string; verdict: RiskVerdict } | null = null;
  const VERDICT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

  // Importee → importers: the narrowed files' test reach and the sample chains below both walk it.
  const reverseGraph = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(summary.componentGraph ?? {})) for (const t of targets) (reverseGraph.get(t) ?? reverseGraph.set(t, []).get(t)!).push(source);
  // Which changed files the diff's lines let us judge by member, and who names what changed in them.
  const narrowing = narrowDependents(summary, changedFiles, options?.symbols);
  for (const file of changedFiles) {
    const b = blastByFile.get(file);
    if (!b) continue;
    const named = narrowing?.byFile.get(file);
    if (named) {
      for (const f of b.affectedFiles) importers.add(f);
      for (const f of b.transitiveFiles) importers.add(f);
      for (const f of named) dependents.add(f);
      // The file-level verdicts (dangerous, moderate, foundation file) describe the module, not this change.
      // What imports the files that name the change, however far, may still hold the test that runs it.
      const reach = reverseReach(reverseGraph, [file, ...named], 8);
      for (const f of reach) reached.add(f);
      const t = b.traceImpact;
      if (!t) continue;
      for (const s of t.screens) if (reach.has(s.file)) screens.set(s.file, s);
      for (const r of t.routes) if (reach.has(r.file)) routes.set(`${r.method ?? ""} ${r.path} ${r.file}`, r);
      for (const e of t.entities) entities.add(e);
      for (const q of t.queues) queues.add(q);
      truncated ||= t.screenCount > t.screens.length || t.routeCount > t.routes.length || t.entityCount > t.entities.length || t.queueCount > t.queues.length;
      continue;
    }
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
  for (const f of dependents) importers.add(f);
  for (const f of changedSet) importers.delete(f);

  // ── Tests to run: test files among changed ∪ dependents ──
  const tests = [...new Set([...changedSet, ...dependents, ...reached])]
    // The summary's layer map is language-aware; the bare check stays as the
    // fallback for summaries written before it was.
    .filter((f) => summary.fileLayerMap?.[f] === "test" || isTestFile(f))
    .sort();

  // ── Sample chains: reverse-import BFS from changed files to a screen/route file ──
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
  // The documents that name what changed: docs to update.
  const docHits = (summary.docDrift?.links ?? [])
    .filter((l) => changedSet.has(l.file))
    .sort((x, y) => byOrdinal(x.doc, y.doc) || x.line - y.line);

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
      .filter(([from, deps]) => !symbolFiles.has(from) && !callerFiles.has(from) && !dependents.has(from) && deps.some((d) => symbolFiles.has(d)))
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

  // ── The tests the coverage run saw execute the change ──
  const measured = summary.testCoverage ? measuredTestsOf(summary.testCoverage, changedFiles, options?.symbols?.changed) : undefined;
  const coverageNote = summary.testCoverage && !measured ? aggregateOnlyNote(summary.testCoverage) : undefined;
  for (const t of measured?.tests ?? []) {
    if (t.file && changedSet.has(t.file) === false && canonical.has(t.file) && !tests.includes(t.file)) tests.push(t.file);
  }

  // ── The tests that exercise the change, and how to run them ──
  const testCode = testCodeIndex(summary);
  const testCallers = options?.symbols
    ? reverseSymbolReach(summary.symbolLinks ?? [], options.symbols.changed, 6)
        .filter((c) => !c.symbol.startsWith("route:") && testCode.isTest(c.file, c.symbol))
        .map((c) => ({ file: c.file, symbol: c.symbol, line: c.line, depth: c.depth }))
        .sort((a, b) => a.depth - b.depth || byOrdinal(a.file, b.file) || a.line - b.line)
    : [];
  // A test declared beside production code (a Rust `#[cfg(test)]` module) is in no test file: its file runs it.
  const inline = testCallers.map((t) => t.file).filter((f) => !tests.includes(f));
  tests.push(...new Set(inline));
  tests.sort();
  const targets = new Map<string, Set<string>>();
  // Measured first: a runner takes them as the report names them.
  for (const t of measured?.tests ?? []) {
    const target = testTargetOf(t);
    if (target) (targets.get(target.file) ?? targets.set(target.file, new Set()).get(target.file)!).add(target.name);
  }
  for (const t of testCallers.length || measured ? testCallers : tests.map((file) => ({ file, symbol: "" }))) {
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
        const fn = coverageFunctionOf(cov.get(s.file), s);
        if (fn && fn.total > 0 && fn.covered === 0) untested.push({ file: s.file, symbol: s.symbol, line: s.line, lines: fn.total });
      }
    } else {
      for (const f of changedFiles) {
        const c = cov.get(f);
        if (c && c.total > 0 && c.covered === 0) untested.push({ file: f, lines: c.total });
      }
    }
  }

  // ── The changed lines no test ran ──
  let patchCoverage: ImpactDiffResult["patchCoverage"];
  if (summary.testCoverage && options?.symbols?.hunks?.size) {
    const cov = new Map(summary.testCoverage.files.map((f) => [f.file, f]));
    const files: NonNullable<ImpactDiffResult["patchCoverage"]>["files"] = [];
    for (const [file, ranges] of options.symbols.hunks) {
      const c = cov.get(file);
      if (!c) continue;
      const missed = new Set(rangeLines(c.uncovered));
      const changed = ranges.flatMap(([a, b]) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i));
      const hit = changed.filter((l) => missed.has(l));
      if (hit.length) files.push({ file, changedLines: changed.length, uncovered: toRanges(hit) });
    }
    if (files.length) patchCoverage = { uncoveredLines: files.reduce((n, f) => n + rangeLines(f.uncovered).length, 0), files: files.sort((a, b) => byOrdinal(a.file, b.file)) };
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
    // Callers, or what else a change can strand: files importing it, overrides on the old signature.
    const whose = breaking.every((c) => c.callers > 0) ? "the callers of" : "what depends on";
    reasons.push(`breaks ${whose} ${breaking.slice(0, 3).map((c) => `${c.symbol} (${describeSignatureChange(c)})`).join(", ")}`);
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

  const limitations: string[] = [];
  if (unknownFiles.length) limitations.push(`${unknownFiles.length} changed file(s) are not in the analysis (${unknownFiles.slice(0, 5).join(", ")}${unknownFiles.length > 5 ? ", …" : ""}), so what they reach was not judged — analyze again to include them`);
  if (truncated) limitations.push("a capped list overflowed, so the counts of screens, routes, data and dependents are lower bounds");
  if (coverageNote) limitations.push(`no per-test evidence: ${coverageNote}`);

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
    ...(narrowing?.byFile.size
      ? {
          narrowed: {
            importers: importers.size,
            files: [...narrowing.byFile.keys()].sort(byOrdinal),
            members: narrowing.members,
            why: sortedDependents.slice(0, DEP_LIST_CAP).map((file) => ({ file, reasons: (narrowing.why.get(file) ?? []).slice(0, 3) })).filter((w) => w.reasons.length),
          },
        }
      : {}),
    tests,
    testCount: tests.length,
    chains,
    ...(missingCoChanges.length > 0 ? { missingCoChanges } : {}),
    ...(docHits.length > 0 ? { docs: docHits.slice(0, 20).map(({ doc, line, text, file }) => ({ doc, line, text, file })), docCount: docHits.length } : {}),
    ...(owners.length > 0 ? { owners } : {}),
    ...(symbolImpact ? { symbolImpact } : {}),
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(untested?.length ? { untested } : {}),
    ...(patchCoverage ? { patchCoverage } : {}),
    ...(measured ? { measuredTests: measured } : {}),
    ...(coverageNote ? { coverageNote } : {}),
    ...(limitations.length ? { limitations } : {}),
    ...(testCallers.length ? { testCallers: testCallers.slice(0, 50) } : {}),
    ...(testCommands.length ? { testCommands } : {}),
    risk: { level, reasons },
  };
  return result;
}

/** Files that reach `starts` by importing, up to `depth` hops. */
function reverseReach(reverse: ReadonlyMap<string, readonly string[]>, starts: readonly string[], depth: number): Set<string> {
  const seen = new Set(starts);
  let frontier = [...starts];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) for (const from of reverse.get(f) ?? []) if (!seen.has(from)) (seen.add(from), next.push(from));
    frontier = next;
  }
  return seen;
}

/**
 * The files that name what each changed file's diff touched, for the changed files the diff's lines let
 * us judge by member: every changed line falls in a function, or in a type whose members were compared
 * before and after. A file with a line outside both (imports, module code), without line ranges, or whose
 * type the analysis cannot say who uses is left out — its importers stay charged, as before.
 */
function narrowDependents(
  summary: ProjectAnalysis,
  changedFiles: readonly string[],
  symbols: NonNullable<Parameters<typeof computeImpactDiff>[2]>["symbols"],
): { byFile: Map<string, Set<string>>; why: Map<string, string[]>; members: Array<{ file: string; name: string; adding?: boolean }> } | undefined {
  if (!symbols?.hunks?.size) return undefined;
  const moduleOnly = new Set(symbols.moduleOnly ?? symbols.moduleLevel);
  const classChanges = symbols.classChanges ?? [];
  const importOnly = new Set(symbols.importOnly);
  const byFile = new Map<string, Set<string>>();
  const why = new Map<string, string[]>();
  const members: Array<{ file: string; name: string; adding?: boolean }> = [];
  const index = namingIndex(summary, changedFiles);
  for (const file of changedFiles) {
    const hunked = symbols.hunks.has(file) || symbols.hunks.old?.has(file) || symbols.hunks.deleted?.has(file);
    if (!hunked || moduleOnly.has(file)) continue;
    const targets: MemberTarget[] = symbols.changed.filter((s) => s.file === file).map((s) => ({ file, symbol: s.symbol }));
    const types = classChanges.filter((c) => c.file === file);
    const readers = symbols.boundReaders?.[file];
    // A class-level hunk with no comparison behind it cannot be judged by member.
    if ((symbols.moduleLevel.includes(file) && !types.length && !importOnly.has(file)) || (!targets.length && !types.length && !importOnly.has(file) && !readers)) continue;
    // A type whose members compare equal changed in a way the comparison does not see (a default, a comment): not judged.
    if (types.some((c) => !c.added.length && !c.changed.length)) continue;
    for (const c of types) {
      targets.push({ file, type: c.name, mode: c.changed.length ? "changed" : "added", interfaceLike: c.interfaceLike, ...(c.addedField ? { field: true as const } : {}) });
    }
    const named = filesNaming(index, targets);
    if (named.undecided) continue;
    // An import edited in a file that forwards names: its importers that import one of them.
    const forwards = symbols.forwarded?.[file];
    if (forwards?.length && importOnly.has(file)) {
      const importers = new Set(index.blast.get(file)?.affectedFiles ?? []);
      for (const f of filesImportingNames(summary, importers, forwards)) {
        const rows = named.files.get(f) ?? named.files.set(f, []).get(f)!;
        rows.push(`imports a name ${file} forwards`);
      }
    }
    // Module-level names the change edited: the files that read them.
    for (const f of readers ?? []) (named.files.get(f) ?? named.files.set(f, []).get(f)!).push("reads a name the change edited");
    byFile.set(file, new Set([...named.files.keys()].filter((f) => !changedFiles.includes(f))));
    for (const [f, reasons] of named.files) {
      const rows = why.get(f) ?? why.set(f, []).get(f)!;
      for (const r of reasons) if (!rows.includes(r)) rows.push(r);
    }
    members.push(...targets.map((t) => ("symbol" in t ? { file, name: t.symbol } : { file, name: t.type, ...(t.mode === "added" ? { adding: true } : {}) })));
  }
  return byFile.size ? { byFile, why, members } : undefined;
}

// ─── Renderers (CLI output) ─────────────────────────────────────────────────

/** "naming what changed (of 25 importing files)": the dependents list was cut to the files that name the members. */
function narrowedNote(r: ImpactDiffResult): string {
  if (!r.narrowed) return "";
  const rest = r.narrowed.importers - r.dependentCount;
  return ` naming what changed (${r.narrowed.importers} files import ${r.narrowed.files.length === 1 ? "it" : "them"}${rest > 0 ? `; the other ${rest} name nothing that changed` : ""})`;
}

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
  if (r.testCount > 0 || r.measuredTests) {
    if (r.testCount > 0) lines.push("", `Tests to run (${r.testCount}):`);
    for (const t of r.tests) lines.push(`  ${t}`);
    if (r.measuredTests) {
      const m = r.measuredTests;
      lines.push("", `Tests the coverage run saw execute the changed functions — measured, per-test contexts from ${m.from.join(", ")} (${m.tests.length} of ${m.tests.length + m.more}):`);
      for (const t of m.tests.slice(0, 20)) lines.push(`  ${measuredLabel(t, true)} — ran ${t.ran.slice(0, 4).join(", ")}${t.ran.length > 4 ? ` … +${t.ran.length - 4}` : ""}`);
      if (m.tests.length > 20) lines.push(`  … +${m.tests.length - 20}`);
    }
    if (r.testCallers?.length) {
      lines.push("", `Tests that call the changed functions (${r.testCallers.length}):`);
      for (const t of r.testCallers.slice(0, 20)) lines.push(`  ${t.symbol} (${t.file}:${t.line})${t.depth > 1 ? ` — ${t.depth} calls away` : ""}`);
    }
    for (const c of r.testCommands ?? []) lines.push(`  run: ${c.command}`);
    if (r.patchCoverage) {
      lines.push("", `Changed lines no test runs: ${r.patchCoverage.uncoveredLines}`);
      for (const f of r.patchCoverage.files) lines.push(`  ${f.file}: ${f.uncovered}`);
    }
    if (r.untested?.length) {
      lines.push("", `Untested — no test runs these (${r.untested.length}):`);
      for (const u of r.untested) lines.push(`  ${u.symbol ? `${u.symbol} (${u.file}:${u.line})` : u.file}`);
    }
  }
  if (r.coverageNote) lines.push("", `Per-test evidence unavailable: ${r.coverageNote}`);
  if (r.missingCoChanges?.length) {
    lines.push("", "Usually changed with, not in this change:");
    for (const m of r.missingCoChanges) lines.push(`  ${m.file}  — with ${m.with} in ${m.count} commits (${Math.round(m.score * 100)}%)${m.hidden ? ", no import joins them" : ""}`);
  }
  if (r.docs?.length) {
    lines.push("", `Docs to update — they name a changed file (${r.docCount ?? r.docs.length}):`);
    for (const d of r.docs) lines.push(`  ${d.doc}:${d.line}  ${d.text}  → ${d.file}`);
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
        const tail = signatureChangeTail(c);
        lines.push(`  ${c.breaking ? "BREAKING " : ""}${c.symbol}  ${what}; ${c.callers} certain caller(s)${tail ? `; ${tail}` : ""}  (${c.file}:${c.line})`);
      }
    }
  }
  if (r.owners?.length) lines.push("", `Owners (CODEOWNERS): ${r.owners.map((o) => `${o.owner} (${o.files})`).join(", ")}`);
  if (r.reviewers?.length) lines.push(`Suggested reviewers: ${r.reviewers.map((x) => `${x.name} (${x.commits} commits to ${x.files} of these files)`).join(", ")}`);
  lines.push("", `Dependent files: ${r.dependentCount}${narrowedNote(r)}`);
  if (r.chains.length > 0) {
    lines.push("", "Chains:");
    for (const c of r.chains) lines.push(`  ${chainLine(c)}`);
  }
  if (r.limitations?.length) {
    lines.push("", "Could not judge:");
    for (const l of r.limitations) lines.push(`  - ${l}`);
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
  if (r.measuredTests) {
    const m = r.measuredTests;
    const rest = m.tests.length - Math.min(10, m.tests.length) + m.more;
    row(`Measured — tests that ran the change (${m.from.join(", ")})`, `${m.tests.slice(0, 10).map((t) => `\`${measuredLabel(t, false)}\``).join(", ")}${rest ? ` … +${rest} more` : ""}`);
  }
  row(`Tests to run (${r.testCount})`, r.tests.map((t) => `\`${t}\``).join(", ") || "—");
  if (r.coverageNote) row("Per-test evidence", `unavailable — ${r.coverageNote}`);
  if (r.testCommands?.length) row("Run", r.testCommands.map((c) => `\`${c.command}\``).join("<br>"));
  if (r.untested?.length) row(`Untested (${r.untested.length})`, r.untested.map((u) => `\`${u.symbol ?? u.file}\``).join(", "));
  if (r.patchCoverage) row(`Changed lines no test runs (${r.patchCoverage.uncoveredLines})`, r.patchCoverage.files.map((f) => `\`${f.file}:${f.uncovered}\``).join(", "));
  if (r.missingCoChanges?.length) {
    row("Usually changed with", r.missingCoChanges.map((m) => `\`${m.file}\` (${Math.round(m.score * 100)}% with \`${m.with}\`)`).join(", "));
  }
  if (r.docs?.length) row(`Docs to update (${r.docCount ?? r.docs.length})`, [...new Set(r.docs.map((d) => `\`${d.doc}:${d.line}\``))].slice(0, 10).join(", "));
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
    if (sig.length) row("Signature changes", sig.map((c) => `${c.breaking ? "**breaking** " : ""}\`${c.symbol}\` ${describeSignatureChange(c)} (${c.callers} caller${c.callers === 1 ? "" : "s"}${signatureChangeTail(c) ? `; ${signatureChangeTail(c)}` : ""})`).join(", "));
  }
  if (r.owners?.length) row("Owners", r.owners.map((o) => `${o.owner} (${o.files})`).join(", "));
  if (r.reviewers?.length) row("Suggested reviewers", r.reviewers.map((x) => `${x.name} (${x.commits} commits)`).join(", "));
  row("Dependents", `${r.dependentCount}${narrowedNote(r)}`);
  if (r.chains.length > 0) {
    md.push("");
    md.push("<details><summary>Dependency chains (UI → changed file)</summary>");
    md.push("");
    for (const c of r.chains) md.push(`- ${chainLine(c)}`);
    md.push("");
    md.push("</details>");
  }
  if (r.limitations?.length) {
    md.push("");
    md.push("**Could not judge**");
    md.push("");
    for (const l of r.limitations) md.push(`- ${l}`);
  }
  return md.join("\n");
}

/** One change a reviewer should read first: a changed or removed function, with what it reaches. */
export interface ReviewPriority {
  /** The function (`Class.method`), or the file when the diff's lines were not read. */
  symbol: string;
  file: string;
  /** 1-based; 0 when only the file is known. */
  line: number;
  risk: "high" | "moderate" | "low";
  /** Why: `breaking`, `removed`, or what it reaches. */
  why: string[];
  /** Functions that call it, directly or up to four calls away (tests and route anchors left out). */
  callers: number;
  routes: number;
  /** The tests that reach it, nearest first — at most three. */
  tests: Array<{ file: string; symbol: string; line: number }>;
  testCount: number;
}

const PRIORITY_SCAN_CAP = 200;

/**
 * The review priorities of an impact result, riskiest first: each changed
 * function (and each removed one, whose callers lose it) with its callers,
 * the routes its callers anchor and the tests that reach it. Without the
 * diff's lines, the changed files by how many files depend on them.
 */
export function reviewPriorities(summary: ProjectAnalysis, r: ImpactDiffResult, limit = 3): ReviewPriority[] {
  const si = r.symbolImpact;
  const links = summary.symbolLinks ?? [];
  const testCode = testCodeIndex(summary);
  const out: Array<ReviewPriority & { score: number }> = [];
  if (si) {
    const sig = new Map((si.signatureChanges ?? []).map((c) => [`${c.file}::${c.symbol}`, c]));
    const targets = new Map<string, ChangedSymbol>(si.changed.slice(0, PRIORITY_SCAN_CAP).map((s) => [`${s.file}::${s.symbol}`, s]));
    // A removed or moved function is not in the new analysis' changed set, but its callers lose it.
    for (const c of si.signatureChanges ?? []) {
      if ((c.kind === "removed" || c.kind === "moved") && !targets.has(`${c.file}::${c.symbol}`)) targets.set(`${c.file}::${c.symbol}`, { file: c.file, symbol: c.symbol, line: c.line, endLine: c.line });
    }
    for (const [key, s] of targets) {
      const reach = reverseSymbolReach(links, [s], 6);
      const calls = reach.filter((c) => !c.symbol.startsWith("route:") && !testCode.isTest(c.file, c.symbol));
      const callers = calls.filter((c) => c.depth <= 4).length;
      const routes = reach.filter((c) => c.symbol.startsWith("route:") && c.depth <= 4).length;
      const tests = reach.filter((c) => !c.symbol.startsWith("route:") && testCode.isTest(c.file, c.symbol));
      const change = sig.get(key);
      const why: string[] = [];
      if (change?.breaking) why.push(`breaking: ${describeSignatureChange(change)}`);
      else if (change) why.push(describeSignatureChange(change));
      if (routes) why.push(`${routes} route(s)`);
      const risk: ReviewPriority["risk"] = change?.breaking || routes > 0 ? "high" : routes > 0 || callers > 0 ? "moderate" : "low";
      const score = (change?.breaking ? 1000 : 0) + (change ? 100 : 0) + routes * 20 + callers + (tests.length ? 0 : 5);
      out.push({ symbol: s.symbol, file: s.file, line: s.line, risk, why, callers, routes, tests: tests.slice(0, 3).map((t) => ({ file: t.file, symbol: t.symbol, line: t.line })), testCount: tests.length, score });
    }
  } else {
    const blast = new Map((summary.blastRadius ?? []).map((b) => [b.filePath, b]));
    for (const f of r.changedFiles) {
      const b = blast.get(f);
      const callers = (b?.affectedFiles.length ?? 0) + (b?.transitiveFiles.length ?? 0);
      const tests = r.tests.filter((t) => b?.affectedFiles.includes(t) || b?.transitiveFiles.includes(t));
      const risk: ReviewPriority["risk"] = b?.changeRisk === "dangerous" ? "high" : b?.changeRisk === "moderate" ? "moderate" : "low";
      out.push({ symbol: f, file: f, line: 0, risk, why: ["file only: the diff's lines were not read"], callers, routes: b?.traceImpact?.routeCount ?? 0, tests: tests.slice(0, 3).map((t) => ({ file: t, symbol: "", line: 0 })), testCount: tests.length, score: (risk === "high" ? 1000 : risk === "moderate" ? 500 : 0) + callers });
    }
  }
  return out
    .sort((a, b) => b.score - a.score || byOrdinal(a.file, b.file) || a.line - b.line)
    .slice(0, limit)
    .map(({ score: _score, ...p }) => p);
}

/**
 * The short form of an impact report: its risk line and the top review
 * priorities, one per line, as text or Markdown.
 */
export function renderImpactBrief(r: ImpactDiffResult, priorities: readonly ReviewPriority[], md = false): string {
  const place = (p: ReviewPriority) => (p.line > 0 ? `${p.file}:${p.line}` : p.file);
  const tests = (p: ReviewPriority) =>
    p.tests.length
      ? `${p.tests.map((t) => (t.symbol ? `${t.symbol} (${t.file}:${t.line})` : t.file)).join(", ")}${p.testCount > p.tests.length ? ` +${p.testCount - p.tests.length}` : ""}`
      : "none";
  const out: string[] = [];
  if (md) {
    out.push(`### ClarifyDoc impact — **${r.risk.level.toUpperCase()}** risk — review first`, "");
    priorities.forEach((p, i) => {
      out.push(`${i + 1}. **${p.risk.toUpperCase()}** \`${place(p)}\` ${p.symbol !== p.file ? `\`${p.symbol}\` ` : ""}— ${p.callers} caller(s); tests: ${tests(p)}${p.why.length ? ` — ${p.why.join("; ")}` : ""}`);
    });
    if (!priorities.length) out.push("Nothing changed in the analysis.");
    if (r.limitations?.length) out.push("", ...r.limitations.map((l) => `- _Could not judge:_ ${l}`));
    return out.join("\n");
  }
  out.push(`Review first — ${priorities.length === 1 ? "the 1 change" : `the ${priorities.length} riskiest changes`}  [risk: ${r.risk.level.toUpperCase()}, base: ${r.baseLabel}]`);
  priorities.forEach((p, i) => {
    out.push(`${i + 1}. ${p.risk.toUpperCase()}  ${place(p)}${p.symbol !== p.file ? `  ${p.symbol}` : ""}`);
    out.push(`   ${p.callers} caller(s); tests: ${tests(p)}${p.why.length ? `; ${p.why.join("; ")}` : ""}`);
  });
  if (!priorities.length) out.push("Nothing changed in the analysis.");
  if (r.limitations?.length) {
    out.push("", "Could not judge:");
    for (const l of r.limitations) out.push(`  - ${l}`);
  }
  return out.join("\n");
}

/**
 * Consumer standing: for each caller of a changed function, whether the
 * change edits it too (`updated`), a test calls it (nearest test function,
 * up to six calls back, through a hub of more than `HUB_CALLERS` (test-functions.ts) production
 * callers only when it calls the hub itself) or a coverage report saw its lines run (`covered`),
 * it is a test itself (`test`), or nothing vouches for it (`unverified`) —
 * the callers a reviewer has to check by hand. Sets `standing` in place.
 */
function standCallers(summary: ProjectAnalysis, changed: readonly ChangedSymbol[], callers: SymbolCaller[]): void {
  const edited = new Set(changed.map((c) => `${c.file}::${c.symbol}`));
  const testCode = testCodeIndex(summary);
  const cov = new Map((summary.testCoverage?.files ?? []).map((f) => [f.file, f]));
  const coverageOf = (c: SymbolCaller) => {
    const name = c.symbol.split(".").pop()!;
    return cov.get(c.file)?.functions?.find((f) => c.line >= f.line && c.line <= f.endLine && f.name.endsWith(name));
  };
  const links = summary.symbolLinks ?? [];
  // Past a hub — a function much of the code calls — only the tests calling the hub itself count.
  const follow = hubFollow(links, testCode);
  for (const c of callers) {
    if (testCode.isTest(c.file, c.symbol)) {
      c.standing = "test";
      continue;
    }
    if (edited.has(`${c.file}::${c.symbol}`)) {
      c.standing = "updated";
      continue;
    }
    const test = reverseSymbolReach(links, [{ file: c.file, symbol: c.symbol, line: c.line, endLine: c.line }], 6, follow)
      .find((t) => !t.symbol.startsWith("route:") && testCode.isTest(t.file, t.symbol));
    if (test) {
      c.standing = "covered";
      c.coveredBy = { file: test.file, symbol: test.symbol };
    } else {
      const fn = coverageOf(c);
      // A test the coverage run saw execute it vouches for it by name.
      const ran = fn && summary.testCoverage ? testsOfCoverageFunction(summary.testCoverage, fn).tests.find((t) => t.file && t.symbol) : undefined;
      c.standing = fn && (fn.covered > 0 || ran) ? "covered" : "unverified";
      if (ran) c.coveredBy = { file: ran.file!, symbol: ran.symbol! };
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

/**
 * The tests a per-test coverage report saw run a changed function: per
 * changed symbol its coverage row, else every function of a changed file.
 * Tests that ran more of the changed functions first. Undefined when the
 * report names no tests for them.
 */
function measuredTestsOf(
  coverage: TestCoverageReport,
  changedFiles: readonly string[],
  symbols: readonly ChangedSymbol[] | undefined,
): ImpactDiffResult["measuredTests"] {
  if (!coverage.tests?.length) return undefined;
  const cov = new Map(coverage.files.map((f) => [f.file, f]));
  const rows: Array<{ label: string; fn: NonNullable<TestCoverageReport["files"][number]["functions"]>[number] }> = [];
  if (symbols?.length) {
    for (const s of symbols) {
      const fn = coverageFunctionOf(cov.get(s.file), s);
      if (fn) rows.push({ label: s.symbol, fn });
    }
  } else {
    for (const f of changedFiles) for (const fn of cov.get(f)?.functions ?? []) rows.push({ label: fn.name, fn });
  }
  return measuredFromRows(coverage, rows);
}

/**
 * The tests a per-test coverage report saw run given functions — what `clarifydoc_explain` shows
 * for a route handler or a function. Undefined when the report names no tests for them.
 */
export function measuredTestsFor(
  summary: Pick<ProjectAnalysis, "testCoverage">,
  targets: ReadonlyArray<{ file: string; symbol: string }>,
): ImpactDiffResult["measuredTests"] {
  const coverage = summary.testCoverage;
  if (!coverage?.tests?.length) return undefined;
  const cov = new Map(coverage.files.map((f) => [f.file, f]));
  const rows: Array<{ label: string; fn: NonNullable<TestCoverageReport["files"][number]["functions"]>[number] }> = [];
  for (const t of targets) {
    const leaf = t.symbol.split(".").pop()!;
    const fns = cov.get(t.file)?.functions ?? [];
    const fn = fns.find((f) => f.name === t.symbol) ?? fns.find((f) => f.name === leaf || f.name.endsWith(`.${leaf}`));
    if (fn) rows.push({ label: t.symbol, fn });
  }
  return measuredFromRows(coverage, rows);
}

function measuredFromRows(
  coverage: TestCoverageReport,
  rows: ReadonlyArray<{ label: string; fn: NonNullable<TestCoverageReport["files"][number]["functions"]>[number] }>,
): ImpactDiffResult["measuredTests"] {
  const byId = new Map<string, CoverageTest & { ran: string[] }>();
  let more = 0;
  for (const { label, fn } of rows) {
    const { tests, count } = testsOfCoverageFunction(coverage, fn);
    more = Math.max(more, count - tests.length);
    for (const t of tests) {
      const entry = byId.get(t.id) ?? byId.set(t.id, { ...t, ran: [] }).get(t.id)!;
      if (!entry.ran.includes(label)) entry.ran.push(label);
    }
  }
  if (!byId.size) return undefined;
  // Stable: equally broad tests keep the report's order.
  const tests = [...byId.values()].sort((a, b) => b.ran.length - a.ran.length);
  return { tests: tests.slice(0, 50), more: more + Math.max(0, tests.length - 50), from: perTestSources(coverage) };
}

/** The coverage row of a changed function: the one declared on its line, else the one spanning it with its name. */
function coverageFunctionOf(file: TestCoverageReport["files"][number] | undefined, s: { symbol: string; line: number; endLine: number }) {
  const leaf = s.symbol.split(".").pop()!;
  return file?.functions?.find((f) => f.line === s.line || (s.line >= f.line && s.endLine <= f.endLine && f.name.endsWith(leaf)));
}

/** A measured test as a reader names it: the marked test function with its place, else the report's id. */
export function measuredLabel(t: CoverageTest, withPlace: boolean): string {
  if (t.symbol && t.line !== undefined) return withPlace ? `${t.symbol} (${t.file}:${t.line})` : t.symbol;
  return t.id;
}

/**
 * A measured test as a runner's target: its analyzed file and symbol, else
 * the file and names its `path::names` id spells (a test file outside the
 * analysis still has a runner). Undefined when the id names no file.
 */
function testTargetOf(t: CoverageTest): { file: string; name: string } | undefined {
  if (t.file && t.symbol) return { file: t.file, name: t.symbol };
  const [path, ...names] = t.id.split("::");
  if (!names.length || !/\.[A-Za-z0-9]+$/.test(path!)) return undefined;
  return { file: path!.replace(/\\/g, "/").replace(/^\.\//, ""), name: names.map((n) => n.replace(/\[.*\]$/, "")).join(".") };
}

/** Each language's command for these tests, from its plugin (`LanguagePluginManifest.testCommand`). */
/**
 * The test functions that reach `targets` through the call graph (up to six
 * calls away), nearest first, and the commands that run just them — what
 * `clarifydoc_explain` puts in its pack, by the same rules the impact uses.
 */
export function testsReaching(
  summary: ProjectAnalysis,
  targets: ReadonlyArray<{ file: string; symbol: string }>,
): { tests: Array<{ file: string; symbol: string; line: number; depth: number }>; commands: Array<{ language: string; command: string }> } {
  const changed = targets.map((t) => ({ file: t.file, symbol: t.symbol, line: 0, endLine: 0 }));
  const testCode = testCodeIndex(summary);
  const tests = reverseSymbolReach(summary.symbolLinks ?? [], changed, 6)
    .filter((c) => !c.symbol.startsWith("route:") && testCode.isTest(c.file, c.symbol))
    .map((c) => ({ file: c.file, symbol: c.symbol, line: c.line, depth: c.depth }))
    .sort((a, b) => a.depth - b.depth || byOrdinal(a.file, b.file) || a.line - b.line);
  const byFile = new Map<string, Set<string>>();
  for (const t of tests) (byFile.get(t.file) ?? byFile.set(t.file, new Set()).get(t.file)!).add(t.symbol);
  return { tests, commands: testCommandsFor(summary, [...byFile].map(([file, names]) => ({ file, names: [...names] }))) };
}

function testCommandsFor(summary: ProjectAnalysis, tests: readonly TestTarget[]): Array<{ language: string; command: string }> {
  if (!tests.length) return [];
  const ctx = {
    packages: new Set((summary.externalPackages ?? []).map((p) => p.name)),
    manifests: new Set((summary.externalPackages ?? []).map((p) => p.declaredIn.slice(p.declaredIn.lastIndexOf("/") + 1))),
    ...(summary.testTargets?.length ? { testTargets: summary.testTargets } : {}),
    projectTests: (summary.projectCommands ?? []).filter((c) => c.kind === "test").map((c) => ({ command: c.command, source: c.source })),
  };
  const byLanguage = new Map<string, TestTarget[]>();
  const testCode = testCodeIndex(summary);
  for (const target of tests) {
    // The marked tests among the names, as the title paths a runner filters by.
    const cases = target.names.flatMap((n) => {
      const row = testCode.testOf(target.file, n);
      // A helper only tests call is reached in turn by the cases calling it.
      return row && row.kind !== "helper" ? [{ path: testFilterPath(row), line: row.line, ...(row.kind === "hook" ? { hook: true as const } : {}) }] : [];
    });
    const suites = summary.testSuites?.[target.file];
    const t: TestTarget = { ...target, ...(cases.length ? { cases } : {}), ...(suites ? { suites } : {}) };
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
