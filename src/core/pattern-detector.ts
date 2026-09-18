import type { FileAnalysis, PatternInfo, FrameworkDetection } from "../types/analysis.js";

/**
 * What a file's own call graph and boundaries say about whether it is one thing
 * or several. Optional: callers that cannot supply it keep the old count-only
 * grading, and the god-object confidence then says "unknown structure" rather
 * than claiming more than is known.
 */
export interface FileStructure {
  /** Sizes of the connected components of the intra-file call graph, largest first. */
  componentSizes: number[];
  /** Share of functions with at least one intra-file call edge, 0..1. */
  participation: number;
  /** Distinct external boundaries the file touches. */
  boundaries: number;
}

/**
 * How much of a god object is really a god object.
 *
 * Counting functions alone puts a cohesive 20-function parser — one connected
 * call graph, no external boundaries — in the same bucket as a 20-method
 * service that mixes database, HTTP and queue across four disjoint groups, and
 * gives both the same "split by responsibility" advice. The intra-file call
 * graph and the boundary count separate them.
 *
 * `low` is not "this is fine": it is a large file that should be judged on its
 * size, not broken up along responsibilities it does not have.
 */
function gradeGodObject(
  count: number,
  structure: FileStructure | undefined,
): { confidence: PatternInfo["confidence"]; detail: string } {
  if (!structure) {
    return { confidence: "medium", detail: "Structure unknown; judged on count alone." };
  }
  const groups = structure.componentSizes.filter((n) => n >= 3).length;
  const largest = structure.componentSizes[0] ?? 0;
  const total = structure.componentSizes.reduce((s, n) => s + n, 0);
  const dominantShare = total > 0 ? largest / total : 0;
  const where = `Touches ${structure.boundaries} boundary/boundaries across ${structure.componentSizes.length} call group(s)`;

  if (structure.participation < 0.5) {
    // Too few functions are connected for the graph to describe the file.
    return {
      confidence: "medium",
      detail: `${where}, but most functions call no sibling, so its internal structure is unclear.`,
    };
  }
  if (groups >= 2 || structure.boundaries >= 3) {
    return {
      confidence: "high",
      detail: `${where} — it holds separable work, so splitting by responsibility is the right move.`,
    };
  }
  if (dominantShare >= 0.8 && structure.boundaries <= 1) {
    return {
      confidence: "low",
      detail: `${where}, and ${Math.round(dominantShare * 100)}% of it is one connected group — large but cohesive, so consider its size rather than its responsibilities.`,
    };
  }
  return { confidence: "medium", detail: `${where}.` };
}

/** A ≤3-line get/set/is/has method with at most one parameter — data-holder
 *  boilerplate, excluded from the god-object method count. */
const isTrivialAccessor = (fn: { name: string; line: number; endLine: number; params: unknown[] }): boolean =>
  /^(?:get|set|is|has)[A-Z_$]/.test(fn.name.split(".").pop() ?? "") &&
  fn.endLine - fn.line <= 2 &&
  fn.params.length <= 1;

/**
 * Detect design patterns and anti-patterns from structural analysis data.
 */
export function detectPatterns(
  analyses: FileAnalysis[],
  frameworks: FrameworkDetection[],
  structure?: ReadonlyMap<string, FileStructure>,
): PatternInfo[] {
  const patterns: PatternInfo[] = [];

  for (const a of analyses) {
    const allMethods = a.classes.flatMap((c) => c.methods);
    const totalFnCount = a.functions.length + allMethods.length;

    // ── Good patterns ──

    // Singleton: class with private constructor + getInstance
    for (const cls of a.classes) {
      const hasGetInstance = cls.methods.some(
        (m) => /^(getInstance|instance|shared)$/i.test(m.name),
      );
      const hasPrivateProps = cls.properties.some(
        (p) => p.visibility === "private" && p.isStatic,
      );
      if (hasGetInstance || hasPrivateProps) {
        patterns.push({
          kind: "singleton",
          name: cls.name,
          filePath: a.filePath,
          line: cls.line,
          confidence: hasGetInstance && hasPrivateProps ? "high" : "medium",
          detail: `Class ${cls.name} uses singleton pattern`,
        });
      }
    }

    // Factory: exported function named create*/build*/*Factory
    for (const fn of a.functions) {
      if (fn.isExported && /^(create|build|make)[A-Z]|Factory$/.test(fn.name)) {
        patterns.push({
          kind: "factory",
          name: fn.name,
          filePath: a.filePath,
          line: fn.line,
          confidence: "medium",
          detail: `Factory function ${fn.name}`,
        });
      }
    }

    // Observer/Event: classes with emit/on/subscribe/addEventListener
    for (const cls of a.classes) {
      const eventMethods = cls.methods.filter(
        (m) => /^(on|off|emit|subscribe|addEventListener|removeEventListener|dispatch)$/.test(m.name),
      );
      if (eventMethods.length >= 2) {
        patterns.push({
          kind: "observer",
          name: cls.name,
          filePath: a.filePath,
          line: cls.line,
          confidence: eventMethods.length >= 3 ? "high" : "medium",
          detail: `Observer pattern with methods: ${eventMethods.map((m) => m.name).join(", ")}`,
        });
      }
    }

    // Custom Hooks (React): exported function named use*
    if (a.language === "typescript" || a.language === "javascript") {
      for (const fn of a.functions) {
        if (fn.isExported && /^use[A-Z]/.test(fn.name) && fn.name !== "<setup>") {
          patterns.push({
            kind: "custom-hook",
            name: fn.name,
            filePath: a.filePath,
            line: fn.line,
            confidence: "high",
            detail: `React custom hook ${fn.name}`,
          });
        }
      }
    }

    // HOC: exported function named with*
    for (const fn of a.functions) {
      if (fn.isExported && /^with[A-Z]/.test(fn.name)) {
        patterns.push({
          kind: "hoc",
          name: fn.name,
          filePath: a.filePath,
          line: fn.line,
          confidence: "medium",
          detail: `Higher-order component ${fn.name}`,
        });
      }
    }

    // Context Provider: imports createContext / provide+inject
    const importsCreateContext = a.imports.some(
      (i) => i.specifiers.includes("createContext"),
    );
    const importsProvide = a.imports.some(
      (i) => i.specifiers.includes("provide") || i.specifiers.includes("inject"),
    );
    if (importsCreateContext || importsProvide) {
      patterns.push({
        kind: "context-provider",
        name: a.filePath.replace(/^.*[\\/]/, "").replace(/\.\w+$/, ""),
        filePath: a.filePath,
        line: 1,
        confidence: "high",
        detail: importsCreateContext ? "React Context Provider" : "Vue provide/inject",
      });
    }

    // Dataclass: Python @dataclass or Java/Kotlin data class
    for (const cls of a.classes) {
      if (cls.decorators.some((d) => d.includes("dataclass"))) {
        patterns.push({
          kind: "dataclass",
          name: cls.name,
          filePath: a.filePath,
          line: cls.line,
          confidence: "high",
          detail: `Python dataclass ${cls.name}`,
        });
      }
    }

    // ABC: Python class extending ABC or using @abstractmethod
    for (const cls of a.classes) {
      const isABC = cls.extends === "ABC" || cls.implements.includes("ABC");
      const hasAbstract = cls.decorators.some((d) => d.includes("abstractmethod")) ||
        cls.methods.some((m) => m.decorators.some((d) => d.includes("abstractmethod")));
      if (isABC || hasAbstract) {
        patterns.push({
          kind: "abc",
          name: cls.name,
          filePath: a.filePath,
          line: cls.line,
          confidence: "high",
          detail: `Abstract base class ${cls.name}`,
        });
      }
    }

    // Middleware: functions with (req, res, next) signature or @Injectable + NestMiddleware
    for (const fn of a.functions) {
      const paramNames = fn.params.map((p) => p.name);
      if (
        paramNames.length === 3 &&
        paramNames.includes("req") &&
        paramNames.includes("res") &&
        paramNames.includes("next")
      ) {
        patterns.push({
          kind: "middleware",
          name: fn.name,
          filePath: a.filePath,
          line: fn.line,
          confidence: "high",
          detail: `Express-style middleware ${fn.name}`,
        });
      }
    }
    for (const cls of a.classes) {
      if (
        cls.decorators.some((d) => d.includes("Injectable")) &&
        cls.implements.some((i) => i.includes("Middleware"))
      ) {
        patterns.push({
          kind: "middleware",
          name: cls.name,
          filePath: a.filePath,
          line: cls.line,
          confidence: "high",
          detail: `NestJS middleware ${cls.name}`,
        });
      }
    }

    // ── Anti-patterns ──

    // God Object: 15+ functions/methods. Trivial accessors don't count — a
    // Java/C# entity with 20 hand-written getters/setters is a data holder,
    // not a god object (each is ≤3 lines with at most one parameter).
    const godFnCount =
      a.functions.filter((f) => !isTrivialAccessor(f)).length +
      allMethods.filter((m) => !isTrivialAccessor(m)).length;
    if (godFnCount > 15) {
      const graded = gradeGodObject(godFnCount, structure?.get(a.filePath));
      patterns.push({
        kind: "god-object",
        name: a.filePath.replace(/^.*[\\/]/, ""),
        filePath: a.filePath,
        line: 1,
        confidence: graded.confidence,
        detail:
          `File has ${godFnCount} non-accessor functions/methods${godFnCount === totalFnCount ? "" : ` (${totalFnCount} total)`}. ` +
          graded.detail,
      });
    }

    // Long File: >500 lines (estimate from last function/class endLine)
    const lastLine = Math.max(
      ...a.functions.map((f) => f.endLine),
      ...a.classes.map((c) => c.endLine),
      0,
    );
    if (lastLine > 500) {
      patterns.push({
        kind: "long-file",
        name: a.filePath.replace(/^.*[\\/]/, ""),
        filePath: a.filePath,
        line: 1,
        confidence: lastLine > 1000 ? "high" : "medium",
        detail: `File has ~${lastLine} lines. Consider breaking into smaller modules.`,
      });
    }
  }

  return patterns;
}
