import type { FileAnalysis, PatternInfo, FrameworkDetection } from "../types/analysis.js";

/**
 * Detect design patterns and anti-patterns from structural analysis data.
 */
export function detectPatterns(
  analyses: FileAnalysis[],
  frameworks: FrameworkDetection[],
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

    // God Object: 15+ functions/methods
    if (totalFnCount > 15) {
      patterns.push({
        kind: "god-object",
        name: a.filePath.replace(/^.*[\\/]/, ""),
        filePath: a.filePath,
        line: 1,
        confidence: totalFnCount > 25 ? "high" : "medium",
        detail: `File has ${totalFnCount} functions/methods. Consider splitting.`,
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
