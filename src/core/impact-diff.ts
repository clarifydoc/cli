import type {
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
  /** Sample reverse-import chains: changed file → … → screen/route file. */
  chains: Array<{ path: string[]; endsAt: "screen" | "route" }>;
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
  options?: { removedFiles?: string[]; baseLabel?: string },
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
  let level: ImpactDiffResult["risk"]["level"] = "low";
  if (dangerous || screens.size >= 8 || (screens.size >= 1 && entities.size >= 3)) {
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
  }
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
