import type {
  FileAnalysis, FileComplexityInfo, PatternInfo, SecurityIssue,
  DuplicateGroup, LayerViolation, HealthScore,
} from "../types/analysis.js";
import { vendoredMinoritySet } from "./security-scanner.js";
import { runtimeGraph } from "./import-kinds.js";

interface HealthInput {
  analyses: FileAnalysis[];
  componentGraph: Record<string, string[]>;
  /** Import edges only `import type` states (import-kinds.ts): cycles through them are no runtime cycles. */
  typeOnlyEdges?: Record<string, string[]>;
  patterns: PatternInfo[];
  securityIssues: SecurityIssue[];
  duplicates: DuplicateGroup[];
  complexity: FileComplexityInfo[];
  layerViolations: LayerViolation[];
  /**
   * Generated/library barrel roots (posix dir paths, from `analyzeUnusedCode`).
   * Files under these are code the team doesn't author or maintain (kubb /
   * openapi-generator output, …), so they're excluded from the health grade —
   * otherwise the repetitive, large, heavily-imported generated surface tanks
   * the score for problems that aren't the team's to fix. Path-prefix only, so
   * this stays language-agnostic.
   */
  generatedRoots?: string[];
  /** Extra generated-code test (e.g. the repository's `generated` globs); OR-ed with the roots above. */
  isGenerated?: (filePath: string) => boolean;
  /** Test code — excluded from every dimension. */
  isTest?: (filePath: string) => boolean;
}

/**
 * Find circular dependencies via Tarjan's SCC on the component graph.
 * Returns non-trivial strongly connected components (size > 1).
 */
export function findCircularDeps(graph: Record<string, string[]>): string[][] {
  const allNodes = new Set<string>();
  for (const [src, targets] of Object.entries(graph)) {
    allNodes.add(src);
    for (const t of targets) allNodes.add(t);
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph[v] ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const node of allNodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}

/** The graded dimensions of the rates-v2 model. */
export type HealthDimensionId =
  | "cycles"
  | "godObjects"
  | "longFiles"
  | "coupling"
  | "security"
  | "duplicates"
  | "layers"
  | "complexity";

/**
 * The rates-v2 health model. Every dimension is a RATE — its count over the
 * basis N = max(minBasis, authored non-test files) — so the same density of
 * problems costs the same in a 60-file service and a 6,000-file monorepo,
 * and points follow `cap · r / (r + rHalf)`: smooth, no cliffs, never more
 * than the cap, half the cap at `rHalf`. `rHalf` is calibrated on a corpus of
 * 22 open-source repositories at twice the median rate, rounded to
 * 1-2-5, so a typical well-kept repo loses about a third of each cap.
 */
export const HEALTH_MODEL = {
  id: "rates-v2",
  minBasis: 50,
  /** A file with more non-test importers than this is "highly coupled". */
  couplingThreshold: 10,
  /** A file holding a function above this cyclomatic complexity counts. */
  complexityThreshold: 20,
  /** Security weights per distinct (file, category). */
  securityWeights: { critical: 3, high: 1, medium: 0.25 } as Record<string, number>,
  // Calibrated 2026-10-07 on 17 of the 22 corpus repos (chatwoot, halo,
  // mealie, netbox, vikunja held out): median 78, no F, Spearman(score, N)
  // −0.25, no dimension at ≥ 80% of its cap in more than a quarter of repos.
  dimensions: {
    cycles: { cap: 10, rHalf: 0.1 },
    godObjects: { cap: 8, rHalf: 0.1 },
    longFiles: { cap: 4, rHalf: 0.05 },
    coupling: { cap: 8, rHalf: 0.1 },
    security: { cap: 10, rHalf: 0.01 },
    duplicates: { cap: 6, rHalf: 0.01 },
    layers: { cap: 6, rHalf: 0.05 },
    complexity: { cap: 8, rHalf: 0.01 },
  } satisfies Record<HealthDimensionId, { cap: number; rHalf: number }>,
} as const;

/** Points a dimension deducts at `rate`: `cap · r / (r + rHalf)`. */
export function dimensionPoints(id: HealthDimensionId, rate: number): number {
  const { cap, rHalf } = HEALTH_MODEL.dimensions[id];
  return rate <= 0 ? 0 : (cap * rate) / (rate + rHalf);
}

/**
 * Compute a composite health score (0-100) with grade (A-F) — the rates-v2
 * model (see `HEALTH_MODEL`). Generated, vendored and minified code is
 * excluded from every dimension, and so are tests: a test fixture's god
 * object or a spec importing everything is not the product's health.
 */
export function computeHealthScore(input: HealthInput): HealthScore {
  // Generated code (kubb / openapi-generator barrels, …) is excluded from every
  // metric below — the team neither authors nor maintains it, so its size,
  // repetition, and heavy fan-in are not health problems to grade.
  const genRoots = input.generatedRoots ?? [];
  const minified = new Set(input.analyses.filter((a) => a.minified).map((a) => a.filePath));
  const vendored = vendoredMinoritySet(input.analyses);
  const isGenerated = (f: string): boolean => {
    if (minified.has(f) || vendored.has(f)) return true;
    if (input.isGenerated?.(f)) return true;
    if (genRoots.length === 0) return false;
    const p = f.replace(/\\/g, "/");
    return genRoots.some((r) => p === r || p.startsWith(r + "/"));
  };
  const isTest = input.isTest ?? (() => false);
  /** Authored, non-test: what the grade is about. */
  const graded = (f: string): boolean => !isGenerated(f) && !isTest(f);

  const basis = Math.max(HEALTH_MODEL.minBasis, input.analyses.filter((a) => graded(a.filePath)).length);
  const dimensions: NonNullable<HealthScore["dimensions"]> = [];
  const penalties: HealthScore["penalties"] = [];
  const grade = (id: HealthDimensionId, count: number, reasons: Array<{ reason: string; share: number }>) => {
    const rate = count / basis;
    const exact = dimensionPoints(id, rate);
    const points = Math.round(exact);
    dimensions.push({ id, count: Math.round(count * 100) / 100, rate: Math.round(rate * 10000) / 10000, points, cap: HEALTH_MODEL.dimensions[id].cap });
    // Several reasons split the dimension's points by their share.
    let left = points;
    reasons.forEach(({ reason, share }, i) => {
      const p = i === reasons.length - 1 ? left : Math.min(left, Math.round(points * share));
      left -= p;
      if (p > 0) penalties.push({ reason, points: p });
    });
  };

  // 1. Cycles: files in a non-trivial strongly connected component, over the
  // graph with generated and test nodes pruned.
  const appGraph: Record<string, string[]> = {};
  for (const [src, targets] of Object.entries(input.componentGraph)) {
    if (!graded(src)) continue;
    appGraph[src] = targets.filter(graded);
  }
  const cycles = findCircularDeps(runtimeGraph(appGraph, input.typeOnlyEdges));
  const cycleFiles = new Set(cycles.flat()).size;
  grade("cycles", cycleFiles, [{ reason: `${cycles.length} circular dependency cycle(s) across ${cycleFiles} file(s)`, share: 1 }]);

  // 2. God objects — a large but COHESIVE file is graded `low` by the detector
  // and does not count.
  const godFiles = new Set(
    input.patterns.filter((p) => p.kind === "god-object" && p.confidence !== "low" && graded(p.filePath)).map((p) => p.filePath),
  );
  grade("godObjects", godFiles.size, [{ reason: `${godFiles.size} god object file(s)`, share: 1 }]);

  // 3. Long files.
  const longFiles = new Set(input.patterns.filter((p) => p.kind === "long-file" && graded(p.filePath)).map((p) => p.filePath));
  grade("longFiles", longFiles.size, [{ reason: `${longFiles.size} long file(s)`, share: 1 }]);

  // 4. Coupling: files more than `couplingThreshold` authored, non-test files import.
  const importers = new Map<string, number>();
  for (const [src, targets] of Object.entries(input.componentGraph)) {
    if (!graded(src)) continue;
    for (const t of new Set(targets)) {
      if (!graded(t) || t === src) continue;
      importers.set(t, (importers.get(t) ?? 0) + 1);
    }
  }
  const coupled = [...importers.values()].filter((n) => n > HEALTH_MODEL.couplingThreshold).length;
  grade("coupling", coupled, [{ reason: `${coupled} highly coupled file(s) (${HEALTH_MODEL.couplingThreshold}+ importers)`, share: 1 }]);

  // 5. Security: the worst severity per distinct (file, category), weighted —
  // one scanner rule firing on forty lines of one file is one finding.
  const worst = new Map<string, string>();
  const rank = (sev: string) => HEALTH_MODEL.securityWeights[sev] ?? 0;
  for (const s of input.securityIssues) {
    if (!graded(s.filePath) || rank(s.severity) === 0) continue;
    const key = `${s.filePath}\0${s.category}`;
    const prev = worst.get(key);
    if (!prev || rank(s.severity) > rank(prev)) worst.set(key, s.severity);
  }
  let critHigh = 0;
  let medium = 0;
  let critHighWeight = 0;
  let mediumWeight = 0;
  for (const sev of worst.values()) {
    if (sev === "medium") {
      medium++;
      mediumWeight += rank(sev);
    } else {
      critHigh++;
      critHighWeight += rank(sev);
    }
  }
  const secWeight = critHighWeight + mediumWeight;
  grade("security", secWeight, [
    ...(critHigh > 0 ? [{ reason: `${critHigh} critical/high security issue(s)`, share: critHighWeight / secWeight }] : []),
    ...(medium > 0 ? [{ reason: `${medium} medium security issue(s)`, share: mediumWeight / secWeight }] : []),
  ]);

  // 6. Duplicates: groups with an authored, non-test occurrence (codegen output
  // is repetitive by construction).
  const duplicates = input.duplicates.filter((d) => (d.occurrences ?? []).some((o) => graded(o.filePath))).length;
  grade("duplicates", duplicates, [{ reason: `${duplicates} duplicate code group(s)`, share: 1 }]);

  // 7. Layer violations, per distinct offending file: one controller reaching
  // into five repositories is one design problem, not five.
  const violations = input.layerViolations.filter((v) => graded(v.sourceFile) && !isGenerated(v.targetFile));
  const violators = new Set(violations.map((v) => v.sourceFile)).size;
  grade("layers", violators, [{ reason: `${violations.length} layer violation(s) from ${violators} file(s)`, share: 1 }]);

  // 8. Complexity: files holding a function above the threshold.
  const complex = input.complexity.filter((f) => graded(f.filePath) && f.maxComplexity > HEALTH_MODEL.complexityThreshold).length;
  grade("complexity", complex, [
    { reason: `${complex} file(s) with very high complexity (a function over ${HEALTH_MODEL.complexityThreshold})`, share: 1 },
  ]);

  const score = Math.max(0, 100 - penalties.reduce((sum, p) => sum + p.points, 0));
  let letter: HealthScore["grade"];
  if (score >= 90) letter = "A";
  else if (score >= 80) letter = "B";
  else if (score >= 70) letter = "C";
  else if (score >= 60) letter = "D";
  else letter = "F";

  return { score, grade: letter, penalties, model: HEALTH_MODEL.id, basis, dimensions };
}
