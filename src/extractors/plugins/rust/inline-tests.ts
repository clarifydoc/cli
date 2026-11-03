import type { FunctionInfo } from "../../../types/analysis.js";

/**
 * Rust's tests live beside the code they test: a `#[cfg(test)] mod tests { … }`
 * inside the source file, its cases carrying `#[test]` (or a runtime's
 * `#[tokio::test]`, `#[sqlx::test]`, `#[rstest]`, `#[test_case(…)]`). The file
 * is no test file, so the functions say it themselves: a test attribute makes a
 * case, and any other function inside a `#[cfg(test)]` module is a helper of
 * the tests (`testCase.kind` `helper`), never production code.
 */

/** `test`, `tokio::test`, `tokio::test(flavor = "multi_thread")`, `rstest`, `test_case(1, 2)`. */
const TEST_ATTRIBUTE = /^(?:(?:[\w]+::)*test|rstest|test_case|test_log::test|quickcheck|proptest)\b/;

/** `#[cfg(test)]` (also `#[cfg(all(test, …))]`) on its own line. */
const CFG_TEST = /^\s*#\[cfg\((?:all\()?\s*test\b[^\]]*\]\s*$/;
const MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/;

/** 1-based spans of every `#[cfg(test)] mod name { … }` body, with the module's name. */
function testModules(lines: readonly string[], blockEnds: (lines: readonly string[]) => ReadonlyMap<number, number>): Array<{ name: string; line: number; endLine: number }> {
  const out: Array<{ name: string; line: number; endLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CFG_TEST.test(lines[i]!)) continue;
    // Other attributes may sit between the `cfg` and the `mod`.
    let j = i + 1;
    while (j < lines.length && /^\s*(?:#\[.*\]\s*)?(?:\/\/.*)?$/.test(lines[j]!)) j++;
    const m = MOD.exec(lines[j] ?? "");
    if (!m) continue;
    const end = blockEnds(lines).get(j);
    if (end !== undefined) out.push({ name: m[1]!, line: j + 1, endLine: end });
  }
  return out;
}

export function markRustTests(lines: string[], fns: FunctionInfo[], blockEnds: (lines: readonly string[]) => ReadonlyMap<number, number>): FunctionInfo[] {
  const mods = lines.some((l) => CFG_TEST.test(l)) ? testModules(lines, blockEnds) : [];
  for (const fn of fns) {
    const inside = mods.filter((m) => m.line < fn.line && fn.endLine <= m.endLine).map((m) => m.name);
    const isCase = fn.decorators.some((d) => TEST_ATTRIBUTE.test(d));
    if (!isCase && !inside.length) continue;
    fn.testCase = { title: fn.name, path: inside, kind: isCase ? "case" : "helper" };
  }
  return fns;
}
