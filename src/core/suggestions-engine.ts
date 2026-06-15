import type {
  FileAnalysis, FileComplexityInfo, PatternInfo, SecurityIssue,
  DuplicateGroup, LayerViolation, BlastRadiusInfo, HealthScore, Suggestion,
} from "../types/analysis.js";
import { findCircularDeps } from "./health-scorer.js";

/** Extract filename from path */
function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

interface SuggestionInput {
  analyses: FileAnalysis[];
  healthScore: HealthScore;
  patterns: PatternInfo[];
  securityIssues: SecurityIssue[];
  duplicates: DuplicateGroup[];
  complexity: FileComplexityInfo[];
  layerViolations: LayerViolation[];
  blastRadius: BlastRadiusInfo[];
  componentGraph: Record<string, string[]>;
  /** Files under a generated/library tree that nothing outside imports (dead code). */
  unusedFiles?: string[];
}

/**
 * Generate prioritized actionable suggestions based on all analysis data.
 */
export function generateSuggestions(input: SuggestionInput): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // ── Critical: Security issues ──
  const critSec = input.securityIssues.filter((s) => s.severity === "critical" || s.severity === "high");
  for (const issue of critSec.slice(0, 10)) {
    suggestions.push({
      priority: "critical",
      category: "Security",
      message: `${issue.message}`,
      filePath: issue.filePath,
      actionable: `Fix ${issue.category} issue at line ${issue.line}`,
    });
  }

  // ── Critical: Circular dependencies (reuse Tarjan SCC from health-scorer) ──
  const cycles = findCircularDeps(input.componentGraph);
  for (const cycle of cycles.slice(0, 5)) {
    const names = cycle.map(fileName);
    suggestions.push({
      priority: "critical",
      category: "Architecture",
      message: `Circular dependency: ${names.join(" → ")} → ${names[0]}`,
      actionable: "Extract shared code to a new module or use dependency injection",
    });
  }

  // ── High: God objects ──
  const godFiles = input.patterns.filter((p) => p.kind === "god-object");
  for (const gf of godFiles.slice(0, 5)) {
    suggestions.push({
      priority: "high",
      category: "Maintainability",
      message: gf.detail,
      filePath: gf.filePath,
      actionable: "Split into smaller, focused modules by responsibility",
    });
  }

  // ── High: High complexity functions ──
  for (const fc of input.complexity) {
    for (const fn of fc.functions) {
      if (fn.complexity > 15) {
        suggestions.push({
          priority: "high",
          category: "Complexity",
          message: `Function ${fn.functionName} has complexity ${fn.complexity}`,
          filePath: fc.filePath,
          actionable: "Refactor by extracting helper functions or using early returns",
        });
      }
    }
  }

  // ── High: Duplicates ──
  for (const dup of input.duplicates.slice(0, 5)) {
    const fileCount = new Set(dup.occurrences.map((o) => o.filePath)).size;
    suggestions.push({
      priority: "high",
      category: "DRY",
      message: `Duplicate function "${dup.functionName}" found in ${fileCount} files`,
      actionable: "Extract to a shared utility module",
    });
  }

  // ── Medium: Layer violations ──
  for (const lv of input.layerViolations.slice(0, 5)) {
    suggestions.push({
      priority: "medium",
      category: "Architecture",
      message: `${lv.sourceLayer} layer imports from ${lv.targetLayer} layer`,
      filePath: lv.sourceFile,
      actionable: `Remove import of ${lv.importSpecifier} or invert the dependency`,
    });
  }

  // ── Medium: Missing tests ──
  const testFiles = new Set(
    input.analyses
      .filter((a) => /\.(test|spec)\.[^.]+$/.test(a.filePath) || a.filePath.includes("__tests__"))
      .map((a) => a.filePath),
  );
  const untestedServices = input.analyses.filter((a) => {
    if (testFiles.has(a.filePath)) return false;
    const baseName = fileName(a.filePath).replace(/\.[^.]+$/, "");
    const hasTest = [...testFiles].some((t) => t.includes(baseName));
    return !hasTest && (
      a.filePath.includes("service") || a.filePath.includes("controller") ||
      a.filePath.includes("handler") || a.routes.length > 0
    );
  });

  if (untestedServices.length > 0) {
    for (const svc of untestedServices.slice(0, 3)) {
      suggestions.push({
        priority: "medium",
        category: "Testing",
        message: `No test file found for ${fileName(svc.filePath)}`,
        filePath: svc.filePath,
        actionable: "Add unit or integration tests",
      });
    }
  }

  // ── High: Dangerous files without tests ──
  if (input.blastRadius.length > 0) {
    const dangerousUntested = input.blastRadius
      .filter((b) => b.changeRisk === "dangerous")
      .filter((b) => {
        const baseName = fileName(b.filePath).replace(/\.[^.]+$/, "");
        return ![...testFiles].some((t) => t.includes(baseName));
      });
    for (const bf of dangerousUntested.slice(0, 3)) {
      suggestions.push({
        priority: "high",
        category: "Blast Radius",
        message: `${fileName(bf.filePath)} is dangerous to change (${bf.directDependents} direct, ${bf.transitiveDependents} transitive dependents) and has no tests`,
        filePath: bf.filePath,
        actionable: "Add comprehensive tests — changes here propagate widely",
      });
    }

    // Fragile nodes: high inbound AND high outbound
    const fragileNodes = input.blastRadius
      .filter((b) => b.directDependents >= 3 && b.dependsOn.length >= 3);
    for (const fn of fragileNodes.slice(0, 3)) {
      suggestions.push({
        priority: "medium",
        category: "Blast Radius",
        message: `${fileName(fn.filePath)} is a fragile node (${fn.directDependents} dependents, imports ${fn.dependsOn.length} files)`,
        filePath: fn.filePath,
        actionable: "Consider splitting — this file is both a key dependency and tightly coupled to others",
      });
    }

    // High-impact exported symbols
    for (const br of input.blastRadius.slice(0, 5)) {
      for (const sym of br.exportedSymbols) {
        if (sym.usedByCount >= 5) {
          suggestions.push({
            priority: "medium",
            category: "Blast Radius",
            message: `${sym.name} in ${fileName(br.filePath)} is used by ${sym.usedByCount} files`,
            filePath: br.filePath,
            actionable: "Ensure thorough test coverage — this is a widely consumed API",
          });
        }
      }
    }
  }

  // ── Medium: Unused generated code ──
  // Files in a generated/library tree (kubb, codegen, …) that nothing outside
  // the tree imports — safe to prune or exclude from the build.
  const unused = input.unusedFiles ?? [];
  if (unused.length > 0) {
    // Track the single most-populated directory in one pass for the "e.g." hint.
    const byDir = new Map<string, number>();
    let topDir = "";
    let topCount = 0;
    for (const f of unused) {
      const dir = f.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
      const n = (byDir.get(dir) ?? 0) + 1;
      byDir.set(dir, n);
      if (n > topCount) { topCount = n; topDir = dir; }
    }
    suggestions.push({
      priority: "medium",
      category: "Dead Code",
      message: `${unused.length} generated file(s) appear unused — nothing outside their tree imports them (e.g. ${topCount} under ${topDir})`,
      actionable: "Prune unused generated output, or narrow your generator config to only the endpoints you consume. Use the Architecture tab's “Hide unused” toggle to focus the graph.",
    });
  }

  // ── Low: Debug statements ──
  const debugIssues = input.securityIssues.filter((s) => s.category === "debug-statement" && s.severity === "low");
  if (debugIssues.length > 0) {
    suggestions.push({
      priority: "low",
      category: "Cleanup",
      message: `${debugIssues.length} file(s) with debug/console statements`,
      actionable: "Remove debug statements before production",
    });
  }

  // ── Low: TODO/FIXME ──
  const todoIssues = input.securityIssues.filter((s) => s.category === "todo-fixme");
  if (todoIssues.length > 0) {
    suggestions.push({
      priority: "low",
      category: "Cleanup",
      message: `${todoIssues.length} file(s) with TODO/FIXME comments`,
      actionable: "Address or remove pending TODO items",
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions;
}
