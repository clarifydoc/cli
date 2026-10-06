import type {
  FileAnalysis, FileComplexityInfo, PatternInfo, SecurityIssue,
  DuplicateGroup, LayerViolation, BlastRadiusInfo, HealthScore, Suggestion,
  RefactorPressureInfo, DeadCodeReport,
} from "../types/analysis.js";
import { findCircularDeps } from "./health-scorer.js";
import { describeDrivers, describeGates } from "./refactor-pressure.js";

/** Extract filename from path */
function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Label each file in a cycle uniquely. Uses the basename, but when two members
 * share one (common across replicated microservices, e.g. several
 * `InternalsController.cs`), extends each colliding label leftward with parent
 * directory segments until the labels are distinct — so the message names three
 * real files rather than looking like a self-loop.
 */
export function distinctCycleLabels(paths: string[]): string[] {
  const labels = paths.map(fileName);
  const hasCollision = new Set(labels).size !== labels.length;
  if (!hasCollision) return labels;
  return paths.map((p) => {
    const segs = p.split("/");
    // Walk leftward until this label is unique among the cycle's paths.
    for (let take = 2; take <= segs.length; take++) {
      const label = segs.slice(-take).join("/");
      const collides = paths.some(
        (o) => o !== p && o.split("/").slice(-take).join("/") === label,
      );
      if (!collides) return label;
    }
    return p;
  });
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
  /** Authored code no entry point reaches, and unused exports (dead-code.ts). */
  deadCode?: DeadCodeReport;
  /** Composite refactor pressure, highest first (refactor-pressure.ts). */
  refactorPressure?: RefactorPressureInfo[];
}

/** Turn a pressure row's drivers into the one action most likely to relieve it. */
export function pressureAction(p: RefactorPressureInfo): string {
  const d = new Set(p.drivers);
  const g = new Set(p.gates);
  if (d.has("mixed_concerns") || g.has("concern_overload")) {
    const roles = p.evidence.roles.filter((r) => r !== "observability" && r !== "configuration");
    const where = p.concentration
      ? p.concentration.mixedSymbols > 0
        ? `; ${p.concentration.mixedSymbols} function(s) mix concerns on their own, starting with ${p.concentration.topSymbols
            .slice(0, 2)
            .map((t) => `${t.symbol}@${t.line}`)
            .join(" and ")}`
        : `; no single function mixes them, so the split is along the ${p.concentration.symbolsWithBoundary} functions that touch a boundary`
      : "";
    return `Split by responsibility — it mixes ${roles.join(", ")}${where}; move each boundary behind its own module`;
  }
  if (g.has("dependency_hub") || (d.has("many_dependents") && d.has("many_dependencies"))) {
    return "Narrow the public surface and push shared pieces into a leaf module — this file is both a hub and a heavy importer";
  }
  if (d.has("dependency_cycle")) return "Break the import cycle — extract the shared part or invert the dependency";
  if (d.has("high_cognitive_complexity") || d.has("high_cyclomatic_complexity") || d.has("deep_nesting")) {
    return "Flatten the most nested functions — extract guards and helpers, replace nested conditionals with early returns";
  }
  if (d.has("high_churn") || g.has("churn_hotspot")) return "Stabilize before the next change — add tests around what keeps changing, then simplify";
  if (d.has("large_file") || g.has("god_class")) return "Break the file up along the seams its functions already form";
  return "Review the drivers listed and pick the cheapest one to relieve first";
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
    // Disambiguate same-basename members (e.g. one `InternalsController.cs` per
    // microservice) so the message doesn't read as a file depending on itself.
    const names = distinctCycleLabels(cycle);
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
    // `low` means the detector found one connected call group and no real
    // boundaries: the file is large, but there are no responsibilities to split
    // it along, and telling someone to split it anyway sends them looking for
    // seams that are not there.
    const cohesive = gf.confidence === "low";
    suggestions.push({
      priority: cohesive ? "medium" : "high",
      category: "Maintainability",
      message: gf.detail,
      filePath: gf.filePath,
      actionable: cohesive
        ? "Large but cohesive — judge it on size, and split only if a group of functions gains its own reason to change"
        : "Split into smaller, focused modules by responsibility",
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

  // ── Refactor pressure: the composite ranking of where to refactor first ──
  // Only the strong/urgent bands become suggestions; the full ranking stays
  // in `refactorPressure` for the report and the MCP health tool.
  const pressing = (input.refactorPressure ?? []).filter((p) => p.band === "urgent" || p.band === "strong");
  for (const p of pressing.slice(0, 5)) {
    const parts = [describeDrivers(p.drivers)];
    if (p.gates.length > 0) parts.push(`gates: ${describeGates(p.gates)}`);
    suggestions.push({
      priority: p.band === "urgent" ? "high" : "medium",
      category: "Refactor pressure",
      message: `${fileName(p.filePath)} scores ${p.score}/100 (${p.band}) — ${parts.filter(Boolean).join("; ")}`,
      filePath: p.filePath,
      actionable: pressureAction(p),
      evidence: [...p.drivers, ...p.gates.map((g) => `gate:${g}`)],
      confidence: p.confidence,
    });
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

  // ── Medium/Low: Unreachable authored code ──
  // Files no entry point reaches (static walk from package entries and
  // framework conventions), and exports no other file imports.
  const dead = input.deadCode;
  if (dead && dead.files.length > 0) {
    // Cluster tops first: deleting one is what unblocks the files below it.
    const tops = dead.files.filter((f) => f.deadImporters === 0);
    const sure = dead.files.filter((f) => f.confidence === "INFERRED").length;
    const lines = dead.files.reduce((n, f) => n + (f.lineCount ?? 0), 0);
    const example = (tops[0] ?? dead.files[0])!.filePath;
    suggestions.push({
      priority: "medium",
      category: "Dead Code",
      message: `${dead.files.length} file(s) no entry point reaches${lines > 0 ? ` (${lines} lines)` : ""} — e.g. ${fileName(example)}`,
      filePath: example,
      actionable:
        "Confirm nothing loads these by name (dynamic import with a computed path, a framework convention), then delete them — " +
        "start with files no other dead file imports.",
      evidence: [
        `${sure} with no mention anywhere, ${dead.files.length - sure} ambiguous (named by reachable code or behind an unresolved alias)`,
        `${tops.length} cluster top(s)`,
      ],
    });
  }
  if (dead && dead.exports.length > 0) {
    const local = dead.exports.filter((e) => e.usedInFile).length;
    const byFile = new Map<string, number>();
    for (const e of dead.exports) byFile.set(e.filePath, (byFile.get(e.filePath) ?? 0) + 1);
    const [topFile, topCount] = [...byFile].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    suggestions.push({
      priority: "low",
      category: "Dead Code",
      message: `${dead.exports.length} export(s) no other file imports (e.g. ${topCount} in ${fileName(topFile)})`,
      filePath: topFile,
      actionable: "Delete the unused declarations; for the ones still used inside their own file, drop the `export` keyword.",
      evidence: [`${dead.exports.length - local} unused anywhere`, `${local} used only in their own file`],
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
