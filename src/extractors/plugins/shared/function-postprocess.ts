import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * A function value declared INSIDE another function — a callback in an options object, a local helper, a delegate
 * body — is part of its enclosing function, not a function or method of the file. `spans` are the `[start, end]`
 * lines of every declaration the plugin read, judged against all of them: by the time top-level functions are
 * post-processed, the class methods enclosing a callback are gone from them.
 */
export function dropNestedFunctions<T extends { line: number; endLine: number }>(fns: T[], spans: ReadonlyArray<readonly [number, number]>): T[] {
  return fns.filter((fn) => !spans.some(([start, end]) => start < fn.line && end >= fn.endLine));
}

/** A script file's `<setup>` pseudo-function without the calls `drop` removes (keywords the call pattern read as calls). */
export function tidySetupCalls(fns: FunctionInfo[], drop: (calls: CallInfo[]) => CallInfo[]): void {
  const setup = fns.find((f) => f.name === "<setup>");
  if (setup) setup.calls = drop(setup.calls);
}
