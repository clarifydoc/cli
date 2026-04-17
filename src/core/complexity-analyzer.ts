import type { FunctionInfo, ClassInfo, ComplexityInfo, FileComplexityInfo, Language } from "../types/analysis.js";
import type { TSTree, TSNode } from "../parsers/parser-manager.js";

/** Branch node types per language that increment cyclomatic complexity */
const BRANCH_NODES: Record<string, Set<string>> = {
  typescript: new Set([
    "if_statement", "while_statement", "for_statement", "for_in_statement",
    "switch_case", "catch_clause", "ternary_expression",
  ]),
  javascript: new Set([
    "if_statement", "while_statement", "for_statement", "for_in_statement",
    "switch_case", "catch_clause", "ternary_expression",
  ]),
  python: new Set([
    "if_statement", "elif_clause", "while_statement", "for_statement",
    "except_clause", "with_statement", "conditional_expression",
  ]),
  java: new Set([
    "if_statement", "while_statement", "for_statement", "enhanced_for_statement",
    "catch_clause", "ternary_expression", "switch_block_statement_group",
  ]),
  kotlin: new Set([
    "if_expression", "while_statement", "for_statement",
    "catch_block", "when_entry",
  ]),
  csharp: new Set([
    "if_statement", "while_statement", "for_statement", "foreach_statement",
    "catch_clause", "case_switch_label", "conditional_expression",
  ]),
  pascal: new Set([
    "ifStatement", "whileStatement", "forStatement",
    "exceptHandler", "caseItem",
  ]),
  go: new Set([
    "if_statement", "for_statement", "expression_switch_statement",
    "type_switch_statement", "select_statement", "case_clause",
  ]),
  rust: new Set([
    "if_expression", "while_expression", "for_expression", "loop_expression",
    "match_arm", "if_let_expression",
  ]),
  ruby: new Set([
    "if", "unless", "while", "until", "for", "case",
    "when", "rescue",
  ]),
  php: new Set([
    "if_statement", "while_statement", "for_statement", "foreach_statement",
    "switch_case", "catch_clause",
  ]),
};

/** Operators that count as branches in binary expressions */
const LOGICAL_OPS: Record<string, Set<string>> = {
  typescript: new Set(["&&", "||", "??"]),
  javascript: new Set(["&&", "||", "??"]),
  python: new Set(["and", "or"]),
  java: new Set(["&&", "||"]),
  kotlin: new Set(["&&", "||"]),
  csharp: new Set(["&&", "||", "??"]),
  pascal: new Set(["and", "or"]),
  go: new Set(["&&", "||"]),
  rust: new Set(["&&", "||"]),
  ruby: new Set(["&&", "||", "and", "or"]),
  php: new Set(["&&", "||", "??"]),
};

/** Count branch nodes in a subtree */
function countBranches(node: TSNode, language: string): number {
  const branchSet = BRANCH_NODES[language] ?? BRANCH_NODES["typescript"];
  const logicalOps = LOGICAL_OPS[language] ?? LOGICAL_OPS["typescript"];
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
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
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

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i)!;
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
  if (language === "dfm") return [];

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
