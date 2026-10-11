import type { FunctionInfo, ClassInfo, ComplexityInfo, FileComplexityInfo, Language } from "../types/analysis.js";
import type { TSTree, TSNode } from "../parsers/parser-manager.js";
import type { LanguageComplexitySpec } from "../types/language-plugin.js";
import { complexityFor, pluginFor } from "../extractors/registry.js";
import { DEFAULT_COMPLEXITY } from "../extractors/shared/complexity-defaults.js";

/** Branch-structure metrics for one function body. */
interface BodyMetrics {
  /** Branch nodes + logical operators — cyclomatic is 1 + this. */
  branches: number;
  /** Cognitive complexity (see `ComplexityInfo.cognitive`). */
  cognitive: number;
  /** Deepest branch nesting level (0 when the body has no branch). */
  nestingDepth: number;
}

/**
 * `else if` / `elif` continuations: a branch whose own node type, or whose
 * parent's, is an else-flavoured clause. Sonar counts these +1 with no nesting
 * penalty and does not deepen nesting for their bodies — they continue the
 * `if` rather than nest inside it. Tree-sitter grammars spell this either as a
 * dedicated clause node (Python `elif_clause`, PHP `else_if_clause`) or as an
 * `if_statement` sitting directly under an `else_clause` (TS/JS, C#, Java).
 */
const ELSE_LIKE = /^else|^elif|else_if|elseif/;

/**
 * Walk a function body once, measuring cyclomatic branches, cognitive
 * complexity and nesting depth together.
 *
 * Cognitive rules (an approximation of SonarSource's specification, sharing
 * the cyclomatic branch table so the two never disagree on WHAT a branch is):
 *  - a branch node adds 1 + its nesting depth, and deepens nesting for its
 *    children;
 *  - an else-like continuation adds 1 and does not deepen nesting;
 *  - a logical operator adds 1 (the cyclomatic rule; Sonar would collapse a
 *    run of identical operators into one — accepted simplification);
 *  - a nested function / lambda (`spec.nestingNodes`) deepens nesting without
 *    adding anything itself. The function's OWN node is exempt: `findBodyNode`
 *    may hand back an enclosing node (the `program` when the function fills the
 *    file, a class body, …), so the first nesting node that starts on the
 *    declaration row is taken to be the function and not charged.
 */
function measureBody(root: TSNode, declRow: number, spec: LanguageComplexitySpec): BodyMetrics {
  const branchSet = spec.branchNodes;
  const logicalOps = spec.logicalOps;
  const nestingSet = spec.nestingNodes;
  const m: BodyMetrics = { branches: 0, cognitive: 0, nestingDepth: 0 };
  let selfSeen = false;

  function walk(n: TSNode, depth: number, parentType: string | null) {
    let childDepth = depth;
    const type = n.type;

    if (branchSet.has(type)) {
      m.branches++;
      const continuation = ELSE_LIKE.test(type) || (parentType !== null && ELSE_LIKE.test(parentType));
      if (continuation) {
        m.cognitive += 1;
      } else {
        m.cognitive += 1 + depth;
        childDepth = depth + 1;
        if (childDepth > m.nestingDepth) m.nestingDepth = childDepth;
      }
    } else if (nestingSet !== undefined && nestingSet.has(type)) {
      if (!selfSeen && n.startPosition.row === declRow) {
        selfSeen = true; // the function being measured
      } else {
        childDepth = depth + 1;
      }
    }

    // Logical operators in binary expressions count as a branch (cyclomatic)
    // and as one cognitive increment.
    const opField = type === "binary_expression" || type === "boolean_operator" ? n.childForFieldName("operator") : null;
    if (opField) {
      if (logicalOps.has(opField.text)) {
        m.branches++;
        m.cognitive++;
      }
    } else if (spec.logicalOpNodes?.has(type)) {
      // `build && deploy || rollback`: the operator is a token child —
      // unnamed (the shell's `list`) or a named leaf (F#'s `infix_op`).
      for (const child of n.children) {
        const op = child.isNamed ? (child.childCount === 0 ? child.text : "") : child.type;
        if (logicalOps.has(op)) {
          m.branches++;
          m.cognitive++;
        }
      }
    }

    for (const child of n.children) {
      walk(child, childDepth, type);
    }
  }

  walk(root, 0, null);
  return m;
}

/**
 * Find the AST node covering a given line range.
 *
 * `endRow` memoizes `Node.endPosition` lookups (a WASM call per access,
 * unlike the free `startPosition` field) across the repeated per-function
 * walks; already-computed rows are passed down the recursion so each node's
 * span is read at most once per file.
 *
 * Exported so `control-flow.ts` measures the SAME body node this analyzer
 * counted: a graph built from a different node could not explain the number.
 */
export function findBodyNode(
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
export function makeEndRowMemo(): (n: TSNode) => number {
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
 * Measure one function: find its body node under `root` by line range, count
 * its branches and nesting, and shape the result as a complexity row.
 *
 * @param functionName - The row's name, `Class.method` for methods
 * @param fn - The declaration, for its line range and parameter count
 * @param root - The file's parse tree
 * @param spec - The language's complexity tables
 * @param endRow - How to read a node's end row (differs per grammar)
 */
function rowFor(
  functionName: string,
  fn: FunctionInfo,
  root: TSNode,
  spec: LanguageComplexitySpec,
  endRow: (n: TSNode) => number,
): ComplexityInfo {
  const body = findBodyNode(root, fn.line, fn.endLine, endRow);
  const m = body ? measureBody(body, fn.line - 1, spec) : { branches: 0, cognitive: 0, nestingDepth: 0 };
  return {
    functionName,
    complexity: 1 + m.branches,
    line: fn.line,
    endLine: fn.endLine,
    cognitive: m.cognitive,
    nestingDepth: m.nestingDepth,
    paramCount: fn.params.length,
  };
}

/**
 * Compute complexity for each function/method in a file: cyclomatic
 * (1 + branches), cognitive, nesting depth and parameter count.
 */
export function computeComplexity(
  tree: TSTree,
  language: Language,
  functions: FunctionInfo[],
  classes: ClassInfo[],
): ComplexityInfo[] {
  // Custom-parsed resource formats (e.g. .dfm) have no code complexity.
  if (pluginFor(language)?.parsing === "custom") return [];

  const spec = complexityFor(language) ?? DEFAULT_COMPLEXITY;
  const results: ComplexityInfo[] = [];
  const root = tree.rootNode;
  const endRow = makeEndRowMemo();

  // Process top-level functions
  for (const fn of functions) {
    if (fn.name === "<setup>") continue;
    results.push(rowFor(fn.name, fn, root, spec, endRow));
  }

  // Process class methods
  for (const cls of classes) {
    for (const method of cls.methods) {
      results.push(rowFor(`${cls.name}.${method.name}`, method, root, spec, endRow));
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
      const out: FileComplexityInfo = {
        filePath: f.filePath,
        totalComplexity: total,
        maxComplexity: max,
        averageComplexity: Math.round((total / f.complexities.length) * 10) / 10,
        functions: f.complexities,
      };
      // Rows cached by an older extractor carry no cognitive fields — leave
      // the aggregates out rather than reporting a misleading zero.
      if (f.complexities.some((c) => c.cognitive !== undefined)) {
        out.totalCognitive = f.complexities.reduce((s, c) => s + (c.cognitive ?? 0), 0);
        out.maxCognitive = Math.max(...f.complexities.map((c) => c.cognitive ?? 0));
        out.maxNestingDepth = Math.max(...f.complexities.map((c) => c.nestingDepth ?? 0));
      }
      return out;
    });
}
