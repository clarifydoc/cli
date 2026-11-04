import type { ComplexityInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { ConditionalBlock, RegexLangSpec } from "../extractors/plugins/shared/regex-base.js";
import { blankStringLiterals } from "../extractors/plugins/shared/regex-base.js";
import { REGEX_COMPLEXITY_DEFAULT } from "../extractors/shared/complexity-defaults.js";
import { regexStructureMetrics, ternaryCount } from "./control-flow-regex.js";

/**
 * Cyclomatic complexity for the regex path, where there is no tree to walk:
 * 1 + the branch keywords, logical operators and `a ? b : c` conditionals in a function's body lines,
 * strings and comments blanked first (the plugins' shared line blanker, plus
 * backtick strings). The vocabulary is `REGEX_COMPLEXITY_DEFAULT` unless the
 * spec overrides it. A `match`/`case`/`select` counts once — its arms are not
 * read — so the number is a floor, marked `approximate` like the regex-path
 * control-flow graph. A compile-time conditional the spec reports
 * (`conditionalBlocks`) counts as its arm with the most decisions — one arm is
 * compiled — and its directive lines count nothing. Cognitive complexity and nesting depth come from the
 * structure the regex control-flow scanner synthesizes, for every language that
 * declares a `regexControlFlow` spec; a language without one leaves them absent,
 * as the type allows.
 */
export function computeRegexComplexity(lines: string[], analysis: FileAnalysis, spec: RegexLangSpec, caseInsensitive: boolean): ComplexityInfo[] {
  const flags = caseInsensitive ? "gi" : "g";
  const table = spec.complexity ?? REGEX_COMPLEXITY_DEFAULT;
  const branches = new RegExp(table.branches.source, flags);
  const logical = new RegExp((table.logicalOps ?? REGEX_COMPLEXITY_DEFAULT.logicalOps).source, flags);
  const closers = table.closers ?? REGEX_COMPLEXITY_DEFAULT.closers;
  const out: ComplexityInfo[] = [];
  const count = (line: string): number => {
    let code = blankStringLiterals(line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)), spec.lineCommentPrefixes);
    if (!code.trim()) return 0;
    code = code.replace(closers, " ");
    let n = 0;
    branches.lastIndex = 0;
    while (branches.exec(code)) n++;
    logical.lastIndex = 0;
    while (logical.exec(code)) n++;
    return n + ternaryCount(code, analysis.language);
  };
  // Compile-time conditionals: one arm is compiled, so a block counts as its arm with the most decisions.
  const blocks = spec.conditionalBlocks?.(lines) ?? [];
  /** Decisions on lines `from`…`to` (0-based, inclusive), each of `inside` (blocks within the span, sorted) by its largest arm. */
  const countRange = (from: number, to: number, inside: readonly ConditionalBlock[]): number => {
    let n = 0;
    let i = from;
    let k = 0;
    while (i <= to) {
      while (k < inside.length && inside[k]!.start < i) k++;
      const block = k < inside.length && inside[k]!.start === i ? inside[k]! : undefined;
      if (!block || block.end > to) {
        n += count(lines[i] ?? "");
        i++;
        continue;
      }
      const nested = inside.filter((b) => b.start > block.start && b.end < block.end);
      let best = 0;
      for (const [a, b] of block.arms) best = Math.max(best, countRange(a, b, nested.filter((x) => x.start >= a && x.end <= b)));
      n += best;
      i = block.end + 1;
    }
    return n;
  };
  /** The blocks inside a function's span: `blocks` are sorted by start, so search for the first and walk on. */
  const blocksIn = (from: number, to: number): ConditionalBlock[] => {
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid]!.start < from) lo = mid + 1;
      else hi = mid;
    }
    const out: ConditionalBlock[] = [];
    for (let k = lo; k < blocks.length && blocks[k]!.start < to; k++) if (blocks[k]!.end < to) out.push(blocks[k]!);
    return out;
  };
  const measure = (fn: FunctionInfo, name: string): void => {
    // A test suite's body is its tests, each measured on its own.
    if (!fn.endLine || fn.endLine < fn.line || fn.name === "<setup>" || fn.testCase?.kind === "suite") return;
    const n = countRange(fn.line, Math.min(fn.endLine, lines.length) - 1, blocksIn(fn.line, fn.endLine));
    // Same operator vocabulary as the cyclomatic count above, so the two numbers agree on what an operator is.
    const structure = regexStructureMetrics(lines, analysis.language, { name, line: fn.line, endLine: fn.endLine }, logical);
    out.push({
      functionName: name,
      complexity: 1 + n,
      line: fn.line,
      endLine: fn.endLine,
      ...(structure ? { cognitive: structure.cognitive, nestingDepth: structure.nestingDepth } : {}),
      paramCount: fn.params.length,
      approximate: true,
    });
  };
  for (const fn of analysis.functions) measure(fn, fn.name);
  for (const cls of analysis.classes) for (const m of cls.methods) measure(m, `${cls.name}.${m.name}`);
  return out;
}
