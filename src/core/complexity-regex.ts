import type { ComplexityInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { RegexLangSpec } from "../extractors/plugins/shared/regex-base.js";

/**
 * Cyclomatic complexity for the regex path, where there is no tree to walk:
 * 1 + the branch keywords and logical operators in a function's body lines,
 * comments and string literals blanked first. The keyword table is the shared
 * C-family vocabulary plus the `elif`/`elsif`/`unless`/`until`/`when`/`rescue`
 * spellings of the script languages; a spec overrides it with
 * `RegexLangSpec.complexity`. A `match`/`case`/`select` counts once — its arms
 * are not read — so the number is a floor, never an overcount. Cognitive
 * complexity and nesting depth need structure the text does not give and are
 * left absent, as the type allows. Before this, every regex-path language
 * (Go, Rust, Ruby, Dart, Elixir, …) reported no complexity at all.
 */
const DEFAULT_BRANCHES =
  /\b(?:if|elif|elsif|elseif|for|foreach|while|until|unless|case|when|match|catch|rescue|except|guard|cond|loop|select)\b/g;
const DEFAULT_LOGICAL = /&&|\|\||\b(?:and|or|andalso|orelse)\b/g;

/** Blank string literals and the comment tail of one line so keywords inside them are not read. */
function codeOnly(line: string, commentPrefixes: readonly string[]): string {
  let out = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, (m) => " ".repeat(m.length));
  // Block closers that repeat the opener's keyword (VB `End If`, Fortran `END DO`, `End Select`) open nothing.
  out = out.replace(/\bend\s+(?:if|do|select|while|for|case|match|loop|try|with)\b/gi, " ");
  for (const prefix of commentPrefixes) {
    const at = out.indexOf(prefix);
    if (at >= 0) out = out.slice(0, at);
  }
  return out;
}

export function computeRegexComplexity(lines: string[], analysis: FileAnalysis, spec: RegexLangSpec, caseInsensitive = false): ComplexityInfo[] {
  const flags = caseInsensitive ? "gi" : "g";
  const branches = new RegExp((spec.complexity?.branches ?? DEFAULT_BRANCHES).source, flags);
  const logical = new RegExp((spec.complexity?.logicalOps ?? DEFAULT_LOGICAL).source, flags);
  const out: ComplexityInfo[] = [];
  const measure = (fn: FunctionInfo, name: string): void => {
    if (!fn.endLine || fn.endLine < fn.line || fn.name === "<setup>") return;
    let count = 0;
    for (let i = fn.line; i < Math.min(fn.endLine, lines.length); i++) {
      const code = codeOnly(lines[i] ?? "", spec.lineCommentPrefixes);
      if (!code.trim()) continue;
      count += (code.match(branches) ?? []).length + (code.match(logical) ?? []).length;
    }
    out.push({ functionName: name, complexity: 1 + count, line: fn.line, endLine: fn.endLine, paramCount: fn.params.length });
  };
  for (const fn of analysis.functions) measure(fn, fn.name);
  for (const cls of analysis.classes) for (const m of cls.methods) measure(m, `${cls.name}.${m.name}`);
  return out;
}
