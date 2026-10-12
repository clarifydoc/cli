import type { ComplexityInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { RegexLangSpec } from "../extractors/plugins/shared/regex-base.js";
import { blankStringLiterals } from "../extractors/plugins/shared/regex-base.js";
import { REGEX_COMPLEXITY_DEFAULT } from "../extractors/shared/complexity-defaults.js";
import { regexStructureMetrics } from "./control-flow-regex.js";

/**
 * Cyclomatic complexity for the regex path, where there is no tree to walk:
 * 1 + the branch keywords and logical operators in a function's body lines,
 * strings and comments blanked first (the plugins' shared line blanker, plus
 * backtick strings). The vocabulary is `REGEX_COMPLEXITY_DEFAULT` unless the
 * spec overrides it. A `match`/`case`/`select` counts once — its arms are not
 * read — so the number is a floor, marked `approximate` like the regex-path
 * control-flow graph. Cognitive complexity and nesting depth come from the
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
    return n;
  };
  const measure = (fn: FunctionInfo, name: string): void => {
    if (!fn.endLine || fn.endLine < fn.line || fn.name === "<setup>") return;
    let n = 0;
    for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) n += count(lines[i] ?? "");
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
