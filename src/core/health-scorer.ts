import type {
  FileAnalysis, FileComplexityInfo, PatternInfo, SecurityIssue,
  DuplicateGroup, LayerViolation, HealthScore,
} from "../types/analysis.js";

interface HealthInput {
  analyses: FileAnalysis[];
  componentGraph: Record<string, string[]>;
  patterns: PatternInfo[];
  securityIssues: SecurityIssue[];
  duplicates: DuplicateGroup[];
  complexity: FileComplexityInfo[];
  layerViolations: LayerViolation[];
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

/**
 * Compute a composite health score (0-100) with grade (A-F).
 */
export function computeHealthScore(input: HealthInput): HealthScore {
  let score = 100;
  const penalties: { reason: string; points: number }[] = [];

  function penalize(reason: string, points: number) {
    const actual = Math.min(points, score); // can't go below 0
    if (actual > 0) {
      score -= actual;
      penalties.push({ reason, points: actual });
    }
  }

  // 1. Circular dependencies
  const cycles = findCircularDeps(input.componentGraph);
  if (cycles.length > 0) {
    const pts = Math.min(20, cycles.length * 5);
    penalize(`${cycles.length} circular dependency cycle(s)`, pts);
  }

  // 2. God objects (15+ functions)
  const godFiles = input.patterns.filter((p) => p.kind === "god-object");
  if (godFiles.length > 0) {
    const pts = Math.min(15, godFiles.length * 3);
    penalize(`${godFiles.length} god object file(s)`, pts);
  }

  // 3. Long files
  const longFiles = input.patterns.filter((p) => p.kind === "long-file");
  if (longFiles.length > 0) {
    const pts = Math.min(10, longFiles.length * 2);
    penalize(`${longFiles.length} long file(s)`, pts);
  }

  // 4. High coupling
  const reverseGraph = new Map<string, number>();
  for (const targets of Object.values(input.componentGraph)) {
    for (const t of targets) {
      reverseGraph.set(t, (reverseGraph.get(t) ?? 0) + 1);
    }
  }
  const highlyCoupled = [...reverseGraph.entries()].filter(([, count]) => count > 10);
  if (highlyCoupled.length > 0) {
    const pts = Math.min(15, highlyCoupled.length * 2);
    penalize(`${highlyCoupled.length} highly coupled file(s) (10+ importers)`, pts);
  }

  // 5. Security issues (single pass)
  let critSecCount = 0;
  let medSecCount = 0;
  for (const s of input.securityIssues) {
    if (s.severity === "critical" || s.severity === "high") critSecCount++;
    else if (s.severity === "medium") medSecCount++;
  }
  if (critSecCount > 0) {
    penalize(`${critSecCount} critical/high security issue(s)`, Math.min(20, critSecCount * 5));
  }
  if (medSecCount > 0) {
    penalize(`${medSecCount} medium security issue(s)`, Math.min(10, medSecCount));
  }

  // 6. Code duplicates
  if (input.duplicates.length > 0) {
    const pts = Math.min(10, input.duplicates.length * 2);
    penalize(`${input.duplicates.length} duplicate code group(s)`, pts);
  }

  // 7. Layer violations
  if (input.layerViolations.length > 0) {
    const pts = Math.min(10, input.layerViolations.length * 2);
    penalize(`${input.layerViolations.length} layer violation(s)`, pts);
  }

  // 8. High average complexity
  if (input.complexity.length > 0) {
    const avgComplexity = input.complexity.reduce((s, f) => s + f.averageComplexity, 0) / input.complexity.length;
    if (avgComplexity > 20) {
      penalize(`High average complexity (${Math.round(avgComplexity)})`, 10);
    } else if (avgComplexity > 10) {
      penalize(`Elevated average complexity (${Math.round(avgComplexity)})`, 5);
    }
  }

  // Clamp
  score = Math.max(0, Math.round(score));

  // Grade
  let grade: HealthScore["grade"];
  if (score >= 90) grade = "A";
  else if (score >= 80) grade = "B";
  else if (score >= 70) grade = "C";
  else if (score >= 60) grade = "D";
  else grade = "F";

  return { score, grade, penalties };
}
