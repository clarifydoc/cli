import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** A component story: Storybook `*.stories.tsx`, Histoire `*.story.vue`. */
export const STORY_FILE = /\.(?:story|stories)\.(?:vue|svelte|[cm]?[jt]sx?)$/i;

/**
 * vitest / jest / mocha, whichever the project declares, on the test files — narrowed by the
 * tests' title paths (`-t`, mocha `--grep`) when every file's reaching tests are marked cases.
 */
export function jsTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  // A story is run by its own tool (Storybook, Histoire), not the unit runner.
  const kept = tests.filter((t) => !STORY_FILE.test(t.file));
  const files = [...new Set(kept.map((t) => t.file))].sort();
  if (!files.length) return null;
  const runner = ctx.packages.has("vitest") ? "npx vitest run" : ctx.packages.has("jest") ? "npx jest" : ctx.packages.has("mocha") ? "npx mocha" : ctx.packages.has("@playwright/test") ? "npx playwright test" : null;
  if (!runner) return `npm test -- ${files.join(" ")}`;
  const filter = titleFilter(kept);
  const flag = runner === "npx mocha" ? "--grep" : runner === "npx playwright test" ? "-g" : "-t";
  return `${runner} ${files.join(" ")}${filter ? ` ${flag} ${shellQuote(filter)}` : ""}`;
}

/** Past this many title paths the filter is longer than it is useful: the files are run whole. */
const MAX_TITLES = 12;

/**
 * One name pattern selecting the tests: each title path joined by spaces (how jest, vitest,
 * mocha and Playwright spell a test's full name), regex-escaped, alternated. Null when some file
 * has to run whole: none of its tests reaching the change is a marked case, a hook of the whole
 * file reaches it, or the module's own statements do. (A helper reaching it is reached in turn
 * by the cases that call it, which are listed too.)
 */
function titleFilter(tests: readonly TestTarget[]): string | null {
  const byFile = new Map<string, TestTarget[]>();
  for (const t of tests) (byFile.get(t.file) ?? byFile.set(t.file, []).get(t.file)!).push(t);
  const paths: string[][] = [];
  for (const list of byFile.values()) {
    const cases = list.flatMap((t) => (t.cases ?? []).map((c) => c.path));
    const whole = list.some((t) => t.names.length === 0 || t.names.includes("<setup>"));
    if (!cases.length || whole || cases.some((c) => c.length === 0)) return null;
    paths.push(...cases);
  }
  // A suite selects everything below it: its cases need no pattern of their own.
  const key = (p: string[]) => p.join("\0");
  const unique = [...new Map(paths.map((p) => [key(p), p])).values()];
  const kept = unique.filter((p) => !unique.some((q) => q.length < p.length && q.every((t, i) => t === p[i])));
  if (!kept.length || kept.length > MAX_TITLES) return null;
  const patterns = kept.map((p) => p.join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort();
  // Unanchored: runners match the pattern anywhere in the full name (Playwright's starts with the file).
  return patterns.length === 1 ? patterns[0]! : `(${patterns.join("|")})`;
}

/** Single-quoted for a POSIX shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
