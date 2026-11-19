import { code } from "./addressed-types.js";

/**
 * The testify suites a Go test file runs: for each `suite.Run(t, new(GarageSuite))` / `suite.Run(t, &GarageSuite{})`
 * inside a top-level `func TestGarage(t *testing.T)`, the suite type and that runner. Only a file importing
 * `github.com/stretchr/testify/suite` states any (the `-testify.m` flag exists only in a binary that links it), the
 * import's local name is the receiver (`suite`, or its alias), and a type run by two runners states none — the
 * filter could not tell which one to run.
 */
export function goTestSuites(lines: string[]): Array<{ type: string; runner: string }> {
  let local: string | undefined;
  for (const line of lines) {
    const m = /^\s*(?:import\s+)?(?:([A-Za-z_]\w*)\s+)?"github\.com\/stretchr\/testify\/suite"/.exec(line);
    if (m) { local = m[1] ?? "suite"; break; }
  }
  if (!local || local === "_" || local === ".") return [];
  const run = new RegExp(String.raw`(?<![\w.])${local}\.Run\(\s*[A-Za-z_]\w*\s*,\s*(?:new\(\s*([A-Za-z_]\w*)\s*\)|&\s*([A-Za-z_]\w*)\s*\{)`);
  const found = new Map<string, Set<string>>();
  let runner: string | undefined;
  for (const line of code(lines)) {
    const fn = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(line);
    if (fn) runner = fn[1];
    else if (/^func\b/.test(line)) runner = undefined;
    const m = run.exec(line);
    const type = m?.[1] ?? m?.[2];
    if (type && runner) (found.get(type) ?? found.set(type, new Set()).get(type)!).add(runner);
  }
  return [...found].filter(([, r]) => r.size === 1).map(([type, r]) => ({ type, runner: [...r][0]! }));
}
