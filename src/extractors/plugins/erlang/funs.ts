import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/** `fun kick/1` (a local function) and `fun club:kick/1` (a remote one), as a value. */
const FUN_REFERENCE = /\bfun\s+(?:([a-z][\w@]*)\s*:\s*)?([a-z][\w@]*)\s*\/\s*\d+/g;

/**
 * A function handed on by name — `lists:foreach(fun kick/1, Players)`, `spawn(fun other/0)` — is a reference
 * its function makes, not a call: recorded as one that is `passed` as an argument, so the linker draws a
 * `passes` edge to the function it names, where a call to it would be wrong.
 */
export function erlangFunReferences(analysis: FileAnalysis, rawSource: string): void {
  const lines = rawSource.split(/\r?\n/);
  const functions: FunctionInfo[] = [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)];
  const seen = new Set<FunctionInfo>();
  for (const fn of functions) {
    if (seen.has(fn)) continue;
    seen.add(fn);
    const have = new Set(fn.calls.filter((c) => c.passed).map((c) => `${c.name}@${c.line}`));
    for (let n = fn.line; n <= Math.min(fn.endLine, lines.length); n++) {
      const text = (lines[n - 1] ?? "").replace(/%.*$/, "");
      for (const m of text.matchAll(FUN_REFERENCE)) {
        const name = m[1] ? `${m[1]}:${m[2]}` : m[2]!;
        if (have.has(`${name}@${n}`)) continue;
        have.add(`${name}@${n}`);
        const call: CallInfo = { name, kind: "internal", target: null, line: n, column: m.index, passed: "argument" };
        fn.calls.push(call);
      }
    }
  }
}
