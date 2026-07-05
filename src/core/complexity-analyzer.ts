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

/**
 * Find the AST node covering a given line range.
 *
 * `endRow` memoizes `Node.endPosition` lookups (a WASM call per access,
 * unlike the free `startPosition` field) across the repeated per-function
 * walks; already-computed rows are passed down the recursion so each node's
 * span is read at most once per file.
 */
function findBodyNode(
  root: TSNode,
  startLine: number,
  endLine: number,
  endRow: (n: TSNode) => number,
): TSNode | null {
  let best: TSNode | null = null;
  let bestSpan = -1;

  function walk(n: TSNode, nStart: number, nEnd: number) {
    if (nStart >= startLine && nEnd <= endLine && nEnd - nStart > bestSpan) {
      best = n;
      bestSpan = nEnd - nStart;
    }

    for (const child of n.children) {
      const cStart = child.startPosition.row + 1;
      const cEnd = endRow(child) + 1;
      // Only recurse if child overlaps the target range
      if (cEnd >= startLine && cStart <= endLine) {
        walk(child, cStart, cEnd);
      }
    }
  }

  walk(root, root.startPosition.row + 1, endRow(root) + 1);
  return best;
}

/** Per-file memo for `endPosition.row`, keyed by tree-sitter's stable node id. */
function makeEndRowMemo(): (n: TSNode) => number {
  const cache = new Map<number, number>();
  return (n: TSNode) => {
    let v = cache.get(n.id);
    if (v === undefined) {
      v = n.endPosition.row;
      cache.set(n.id, v);
    }
    return v;
  };
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
  const endRow = makeEndRowMemo();

  // Process top-level functions
  for (const fn of functions) {
    if (fn.name === "<setup>") continue;
    const body = findBodyNode(root, fn.line, fn.endLine, endRow);
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
      const body = findBodyNode(root, method.line, method.endLine, endRow);
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
