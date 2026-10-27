import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** A component story: Storybook `*.stories.tsx`, Histoire `*.story.vue`. */
export const STORY_FILE = /\.(?:story|stories)\.(?:vue|svelte|[cm]?[jt]sx?)$/i;

/** vitest / jest / mocha, whichever the project declares, on the test files (JS test cases are callbacks, not named functions). */
export function jsTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  // A story is run by its own tool (Storybook, Histoire), not the unit runner.
  const files = [...new Set(tests.map((t) => t.file))].filter((f) => !STORY_FILE.test(f)).sort();
  if (!files.length) return null;
  const runner = ctx.packages.has("vitest") ? "npx vitest run" : ctx.packages.has("jest") ? "npx jest" : ctx.packages.has("mocha") ? "npx mocha" : ctx.packages.has("@playwright/test") ? "npx playwright test" : null;
  return runner ? `${runner} ${files.join(" ")}` : `npm test -- ${files.join(" ")}`;
}
