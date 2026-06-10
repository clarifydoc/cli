import type { FunctionInfo, ClassInfo, ComplexityInfo, FileComplexityInfo, Language } from "../types/analysis.js";
import type { TSTree, TSNode } from "../parsers/parser-manager.js";
import { complexityFor, DEFAULT_COMPLEXITY, pluginFor } from "../extractors/registry.js";

/** Count branch nodes in a subtree */
function countBranches(node: TSNode, language: string): number {
  const spec = complexityFor(language) ?? DEFAULT_COMPLEXITY;
  const branchSet = spec.branchNodes;
  const logicalOps = spec.logicalOps;
  let count = 0;

  function walk(n: TSNode) {
    if (branchSet.has(n.type)) {
      count++;
    }
    // Count logical operators in binary expressions
    if (n.type === "binary_expression" || n.type === "boolean_operator") {
      const op = n.childForFieldName("operator");
      if (op && logicalOps.has(op.text)) {
        count++;
      }
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return count;
}

/** Find the AST node covering a given line range */
function findBodyNode(root: TSNode, startLine: number, endLine: number): TSNode | null {
  // Walk tree looking for a function/method body that starts near startLine
  let best: TSNode | null = null;

  function walk(n: TSNode) {
    const nStart = n.startPosition.row + 1;
    const nEnd = n.endPosition.row + 1;

    if (nStart >= startLine && nEnd <= endLine) {
      if (!best || (nEnd - nStart) > (best.endPosition.row - best.startPosition.row)) {
        best = n;
      }
    }

    for (const child of n.children) {
      const cStart = child.startPosition.row + 1;
      const cEnd = child.endPosition.row + 1;
      // Only recurse if child overlaps the target range
      if (cEnd >= startLine && cStart <= endLine) {
        walk(child);
      }
    }
  }

  walk(root);
  return best;
}

/**
 * Compute cyclomatic complexity for each function/method in a file.
 * Base complexity is 1, +1 per branch.
 */
export function computeComplexity(
  tree: TSTree,
  language: Language,
  functions: FunctionInfo[],
  classes: ClassInfo[],
): ComplexityInfo[] {
  // Custom-parsed resource formats (e.g. .dfm) have no code complexity.
  if (pluginFor(language)?.parsing === "custom") return [];

  const results: ComplexityInfo[] = [];
  const root = tree.rootNode;

  // Process top-level functions
  for (const fn of functions) {
    if (fn.name === "<setup>") continue;
    const body = findBodyNode(root, fn.line, fn.endLine);
    const branches = body ? countBranches(body, language) : 0;
    results.push({
      functionName: fn.name,
      complexity: 1 + branches,
      line: fn.line,
      endLine: fn.endLine,
    });
  }

  // Process class methods
  for (const cls of classes) {
    for (const method of cls.methods) {
      const body = findBodyNode(root, method.line, method.endLine);
      const branches = body ? countBranches(body, language) : 0;
      results.push({
        functionName: `${cls.name}.${method.name}`,
        complexity: 1 + branches,
        line: method.line,
        endLine: method.endLine,
      });
    }
  }

  return results;
}

/** Aggregate per-file complexity results into FileComplexityInfo */
export function aggregateComplexity(
  perFile: { filePath: string; complexities: ComplexityInfo[] }[],
): FileComplexityInfo[] {
  return perFile
    .filter((f) => f.complexities.length > 0)
    .map((f) => {
      const total = f.complexities.reduce((s, c) => s + c.complexity, 0);
      const max = Math.max(...f.complexities.map((c) => c.complexity));
      return {
        filePath: f.filePath,
        totalComplexity: total,
        maxComplexity: max,
        averageComplexity: Math.round((total / f.complexities.length) * 10) / 10,
        functions: f.complexities,
      };
    });
}
