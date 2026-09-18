import type {
  BlastRadiusInfo,
  FileAnalysis,
  FileChurnInfo,
  FileComplexityInfo,
  LayerViolation,
  RefactorPressureBand,
  RefactorPressureInfo,
  ResponsibilityProfile,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { findCircularDeps } from "./health-scorer.js";
import { overlayNumbers, type RefactorPressureConfigInput } from "./project-config.js";

/**
 * Refactor pressure: one ranked, explainable composite per file answering
 * "where should we refactor first?".
 *
 * The other analyzers each produce a flat list (complex functions, god
 * objects, hotspots, coupled files, …) and the suggestions engine cuts each
 * at five or ten rows. A file that is moderately bad on every axis never
 * tops any list yet is the one that hurts. This combines five normalized
 * components with configurable weights:
 *
 *   complexity      cognitive complexity + nesting (cyclomatic fallback)
 *   size            physical lines
 *   responsibility  distinct concerns mixed (responsibility-profile.ts)
 *   coupling        dependents, dependencies, cycle membership, layer violations
 *   churn           commits and authors in the git window
 *
 * Every row carries the drivers that pushed it, the hard gates that fired
 * regardless of the weighted score, and a confidence equal to the share of
 * component weight that had evidence — a project without git history, or a
 * regex-only language without complexity rows, is scored on what IS known
 * and says so instead of silently scoring lower.
 *
 * Thresholds live in `DEFAULT_REFACTOR_PRESSURE_CONFIG` and can be overridden
 * per repository in `.clarifydoc/config.json` under `refactorPressure`.
 * Deterministic; test files and generated/vendored code are excluded.
 */

export interface RefactorPressureConfig {
  /** Component weights; normalized at scoring time so they need not sum to 1. */
  weights: { complexity: number; size: number; responsibility: number; coupling: number; churn: number };
  /** Value at which a raw metric saturates its 0–100 normalization. */
  ceilings: {
    maxCognitive: number;
    totalCognitive: number;
    nestingDepth: number;
    maxCyclomatic: number;
    totalCyclomatic: number;
    loc: number;
    concerns: number;
    fanIn: number;
    fanOut: number;
    layerViolations: number;
    commits: number;
    authors: number;
  };
  /** Lower bound of each band; below `observe` is "none". */
  bands: { observe: number; suggest: number; strong: number; urgent: number };
  gates: {
    godClassLoc: number;
    godClassCognitive: number;
    concernOverload: number;
    hubFanIn: number;
    hubFanOut: number;
    /** Commits percentile (0–100) a file must reach to be a churn hotspot… */
    churnHotspotPercentile: number;
    /** …and at least this many commits, so tiny histories don't gate. */
    churnHotspotMinCommits: number;
    /** …while its complexity component is at least this. */
    churnHotspotComplexity: number;
  };
  driverThreshold: number;
}

export const DEFAULT_REFACTOR_PRESSURE_CONFIG: RefactorPressureConfig = {
  weights: { complexity: 0.25, size: 0.1, responsibility: 0.2, coupling: 0.2, churn: 0.25 },
  ceilings: {
    maxCognitive: 50,
    totalCognitive: 200,
    nestingDepth: 5,
    maxCyclomatic: 30,
    totalCyclomatic: 150,
    loc: 800,
    concerns: 4,
    fanIn: 15,
    fanOut: 15,
    layerViolations: 3,
    commits: 30,
    authors: 5,
  },
  bands: { observe: 25, suggest: 45, strong: 60, urgent: 75 },
  gates: {
    godClassLoc: 500,
    godClassCognitive: 120,
    concernOverload: 4,
    hubFanIn: 10,
    hubFanOut: 10,
    churnHotspotPercentile: 90,
    // 24-month window: fewer than ten commits is a normal file, not a hotspot,
    // whatever percentile it lands in on a quiet repository.
    churnHotspotMinCommits: 10,
    churnHotspotComplexity: 50,
  },
  driverThreshold: 50,
};

/** Merge a project's `refactorPressure` section over the defaults, warning on bad input. */
export function resolveRefactorPressureConfig(
  input: RefactorPressureConfigInput | undefined,
  warn: (msg: string) => void = () => {},
): RefactorPressureConfig {
  const d = DEFAULT_REFACTOR_PRESSURE_CONFIG;
  if (!input) return d;
  const cfg: RefactorPressureConfig = {
    weights: overlayNumbers("refactorPressure.weights", d.weights, input.weights, warn),
    ceilings: overlayNumbers("refactorPressure.ceilings", d.ceilings, input.ceilings, warn),
    bands: overlayNumbers("refactorPressure.bands", d.bands, input.bands, warn),
    gates: overlayNumbers("refactorPressure.gates", d.gates, input.gates, warn),
    driverThreshold: d.driverThreshold,
  };
  if (input.driverThreshold !== undefined) {
    if (typeof input.driverThreshold === "number" && Number.isFinite(input.driverThreshold) && input.driverThreshold >= 0) {
      cfg.driverThreshold = input.driverThreshold;
    } else {
      warn(`refactorPressure.driverThreshold: expected a non-negative number; default kept`);
    }
  }
  const b = cfg.bands;
  if (!(b.observe <= b.suggest && b.suggest <= b.strong && b.strong <= b.urgent)) {
    warn("refactorPressure.bands: must be non-decreasing (observe ≤ suggest ≤ strong ≤ urgent); defaults kept");
    cfg.bands = { ...d.bands };
  }
  const totalWeight = Object.values(cfg.weights).reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    warn("refactorPressure.weights: all weights are zero; defaults kept");
    cfg.weights = { ...d.weights };
  }
  return cfg;
}

export interface RefactorPressureInput {
  analyses: readonly FileAnalysis[];
  complexity: readonly FileComplexityInfo[];
  blastRadius: readonly BlastRadiusInfo[];
  componentGraph: Record<string, string[]>;
  layerViolations: readonly LayerViolation[];
  responsibilityProfiles?: readonly ResponsibilityProfile[];
  /** Undefined when git history was unavailable — the churn component is then marked unavailable. */
  fileChurn?: readonly FileChurnInfo[];
  /** Files to leave out entirely (tests, generated, vendored, minified). */
  exclude?: (filePath: string) => boolean;
  config?: RefactorPressureConfig;
}

const norm = (value: number, ceiling: number): number =>
  ceiling <= 0 ? 0 : Math.min(100, Math.max(0, (value / ceiling) * 100));

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Estimate a file's size from extracted spans when `lineCount` is absent (older artifacts). */
function estimateLoc(a: FileAnalysis): number | null {
  if (a.lineCount !== undefined) return a.lineCount;
  let last = 0;
  for (const f of a.functions) if (f.endLine > last) last = f.endLine;
  for (const c of a.classes) if (c.endLine > last) last = c.endLine;
  return last > 0 ? last : null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Infinity;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export function computeRefactorPressure(input: RefactorPressureInput): RefactorPressureInfo[] {
  const cfg = input.config ?? DEFAULT_REFACTOR_PRESSURE_CONFIG;
  const { ceilings: C, weights: W, gates: G, bands: B } = cfg;
  const exclude = input.exclude ?? (() => false);

  const complexityByFile = new Map(input.complexity.map((c) => [c.filePath, c]));
  const blastByFile = new Map(input.blastRadius.map((b) => [b.filePath, b]));
  const profileByFile = new Map((input.responsibilityProfiles ?? []).map((r) => [r.filePath, r]));
  const churnByFile = input.fileChurn ? new Map(input.fileChurn.map((c) => [c.file, c])) : null;

  const inCycle = new Set<string>();
  for (const scc of findCircularDeps(input.componentGraph)) for (const f of scc) inCycle.add(f);

  const violationsByFile = new Map<string, number>();
  for (const v of input.layerViolations) {
    violationsByFile.set(v.sourceFile, (violationsByFile.get(v.sourceFile) ?? 0) + 1);
    violationsByFile.set(v.targetFile, (violationsByFile.get(v.targetFile) ?? 0) + 1);
  }

  const candidates = input.analyses.filter((a) => !exclude(a.filePath));

  // Churn hotspot gate threshold: the p-th percentile of commits over the
  // candidates that have churn, floored so small histories cannot gate.
  let hotspotCommits = Infinity;
  if (churnByFile) {
    const commits = candidates
      .map((a) => churnByFile.get(a.filePath)?.commits ?? 0)
      .filter((n) => n > 0)
      .sort((x, y) => x - y);
    hotspotCommits = Math.max(G.churnHotspotMinCommits, percentile(commits, G.churnHotspotPercentile));
  }

  const results: RefactorPressureInfo[] = [];

  for (const a of candidates) {
    const cx = complexityByFile.get(a.filePath);
    const blast = blastByFile.get(a.filePath);
    const profile = profileByFile.get(a.filePath);
    const churn = churnByFile?.get(a.filePath);

    // ── Complexity: cognitive when available, cyclomatic otherwise ────────
    let complexityScore: number | null = null;
    let maxCognitive: number | null = null;
    let totalCognitive: number | null = null;
    let maxNesting: number | null = null;
    let maxCyclomatic = 0;
    let totalCyclomatic = 0;
    let functionCount = 0;
    let cognitiveNorm = 0;
    let nestingNorm = 0;
    if (cx) {
      functionCount = cx.functions.length;
      maxCyclomatic = cx.maxComplexity;
      totalCyclomatic = cx.totalComplexity;
      if (cx.maxCognitive !== undefined) {
        maxCognitive = cx.maxCognitive;
        totalCognitive = cx.totalCognitive ?? 0;
        maxNesting = cx.maxNestingDepth ?? 0;
        cognitiveNorm = norm(maxCognitive, C.maxCognitive);
        nestingNorm = norm(maxNesting, C.nestingDepth);
        complexityScore = 0.5 * cognitiveNorm + 0.3 * norm(totalCognitive, C.totalCognitive) + 0.2 * nestingNorm;
      } else {
        cognitiveNorm = norm(maxCyclomatic, C.maxCyclomatic);
        complexityScore = 0.6 * cognitiveNorm + 0.4 * norm(totalCyclomatic, C.totalCyclomatic);
      }
    }

    // ── Size ─────────────────────────────────────────────────────────────
    const loc = estimateLoc(a);
    const sizeScore = loc === null ? null : norm(loc, C.loc);

    // ── Responsibility (absence = genuinely zero boundaries) ──────────────
    const concernCount = profile?.concernCount ?? 0;
    const responsibilityScore = norm(concernCount, C.concerns);

    // ── Coupling ─────────────────────────────────────────────────────────
    const directDependents = blast?.directDependents ?? 0;
    const transitiveDependents = blast?.transitiveDependents ?? 0;
    const dependsOn = blast?.dependsOn.length ?? (input.componentGraph[a.filePath]?.length ?? 0);
    const cyc = inCycle.has(a.filePath);
    const violations = violationsByFile.get(a.filePath) ?? 0;
    const fanInNorm = norm(directDependents, C.fanIn);
    const fanOutNorm = norm(dependsOn, C.fanOut);
    const violationNorm = norm(violations, C.layerViolations);
    const couplingScore = 0.35 * fanInNorm + 0.25 * fanOutNorm + 0.25 * (cyc ? 100 : 0) + 0.15 * violationNorm;

    // ── Churn (unavailable project-wide without git history) ─────────────
    let churnScore: number | null = null;
    let commitsNorm = 0;
    let authorsNorm = 0;
    if (churnByFile) {
      commitsNorm = norm(churn?.commits ?? 0, C.commits);
      authorsNorm = norm(churn?.authorCount ?? 0, C.authors);
      churnScore = 0.6 * commitsNorm + 0.4 * authorsNorm;
    }

    // ── Weighted score over the AVAILABLE components ─────────────────────
    const parts: Array<[number, number | null]> = [
      [W.complexity, complexityScore],
      [W.size, sizeScore],
      [W.responsibility, responsibilityScore],
      [W.coupling, couplingScore],
      [W.churn, churnScore],
    ];
    const totalWeight = parts.reduce((s, [w]) => s + w, 0);
    let available = 0;
    let weighted = 0;
    for (const [w, v] of parts) {
      if (v === null) continue;
      available += w;
      weighted += w * v;
    }
    const score = available > 0 ? round1(Math.min(100, weighted / available)) : 0;
    const confidence = totalWeight > 0 ? Math.round((available / totalWeight) * 100) / 100 : 0;

    // ── Hard gates ───────────────────────────────────────────────────────
    const gates: string[] = [];
    const bigness = totalCognitive ?? Math.round(totalCyclomatic * 1.5);
    if (loc !== null && loc >= G.godClassLoc && bigness >= G.godClassCognitive) gates.push("god_class");
    if (concernCount >= G.concernOverload) gates.push("concern_overload");
    if (directDependents >= G.hubFanIn && dependsOn >= G.hubFanOut) gates.push("dependency_hub");
    if (churn && churn.commits >= hotspotCommits && (complexityScore ?? 0) >= G.churnHotspotComplexity) {
      gates.push("churn_hotspot");
    }

    // ── Drivers ──────────────────────────────────────────────────────────
    const t = cfg.driverThreshold;
    const drivers: string[] = [];
    if (cognitiveNorm > t) drivers.push(maxCognitive !== null ? "high_cognitive_complexity" : "high_cyclomatic_complexity");
    if (nestingNorm > t) drivers.push("deep_nesting");
    if (sizeScore !== null && sizeScore > t) drivers.push("large_file");
    if (responsibilityScore > t) drivers.push("mixed_concerns");
    if (fanInNorm > t) drivers.push("many_dependents");
    if (fanOutNorm > t) drivers.push("many_dependencies");
    if (cyc) drivers.push("dependency_cycle");
    if (violationNorm > t) drivers.push("layer_violations");
    if (commitsNorm > t) drivers.push("high_churn");
    if (authorsNorm > t) drivers.push("many_authors");

    // ── Band ─────────────────────────────────────────────────────────────
    let band: RefactorPressureBand = "none";
    if (score >= B.urgent) band = "urgent";
    else if (score >= B.strong) band = "strong";
    else if (score >= B.suggest) band = "suggest";
    else if (score >= B.observe) band = "observe";
    // A gate is evidence in its own right: one lifts to at least "suggest", two to "strong".
    const rank: Record<RefactorPressureBand, number> = { none: 0, observe: 1, suggest: 2, strong: 3, urgent: 4 };
    const floor: RefactorPressureBand = gates.length >= 2 ? "strong" : gates.length === 1 ? "suggest" : "none";
    if (rank[floor] > rank[band]) band = floor;

    if (band === "none") continue;

    results.push({
      filePath: a.filePath,
      score,
      band,
      components: {
        complexity: complexityScore === null ? null : round1(complexityScore),
        size: sizeScore === null ? null : round1(sizeScore),
        responsibility: round1(responsibilityScore),
        coupling: round1(couplingScore),
        churn: churnScore === null ? null : round1(churnScore),
      },
      drivers,
      gates,
      confidence,
      ...(profile?.symbolsWithBoundary
        ? {
            concentration: {
              symbolsWithBoundary: profile.symbolsWithBoundary,
              mixedSymbols: profile.mixedSymbols ?? 0,
              topSymbols: profile.topSymbols ?? [],
            },
          }
        : {}),
      evidence: {
        loc,
        functions: functionCount,
        maxCyclomatic,
        totalCyclomatic,
        maxCognitive,
        totalCognitive,
        maxNestingDepth: maxNesting,
        concernCount,
        roles: profile?.roles ?? [],
        directDependents,
        transitiveDependents,
        dependsOn,
        inCycle: cyc,
        layerViolations: violations,
        commits: churn ? churn.commits : churnByFile ? 0 : null,
        authors: churn ? churn.authorCount : churnByFile ? 0 : null,
      },
    });
  }

  const rank: Record<RefactorPressureBand, number> = { none: 0, observe: 1, suggest: 2, strong: 3, urgent: 4 };
  results.sort((x, y) => rank[y.band] - rank[x.band] || y.score - x.score || byOrdinal(x.filePath, y.filePath));
  return results;
}

/** Human wording for a driver id, for suggestions and MCP text. */
export const DRIVER_LABELS: Record<string, string> = {
  high_cognitive_complexity: "high cognitive complexity",
  high_cyclomatic_complexity: "high cyclomatic complexity",
  deep_nesting: "deep nesting",
  large_file: "large file",
  mixed_concerns: "mixed concerns",
  many_dependents: "many dependents",
  many_dependencies: "many dependencies",
  dependency_cycle: "in a dependency cycle",
  layer_violations: "layer violations",
  high_churn: "high churn",
  many_authors: "many authors",
};

export const GATE_LABELS: Record<string, string> = {
  god_class: "god class",
  concern_overload: "concern overload",
  dependency_hub: "dependency hub",
  churn_hotspot: "churn hotspot",
};

export const describeDrivers = (ids: readonly string[]): string =>
  ids.map((d) => DRIVER_LABELS[d] ?? d).join(", ");
export const describeGates = (ids: readonly string[]): string =>
  ids.map((g) => GATE_LABELS[g] ?? g).join(", ");
