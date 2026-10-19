import type { TestCommandContext, TestTarget } from "../../../types/language-plugin.js";

/** vitest / jest / mocha, whichever the project declares, on the test files (JS test cases are callbacks, not named functions). */
export function jsTestCommand(tests: readonly TestTarget[], ctx: TestCommandContext): string | null {
  const files = [...new Set(tests.map((t) => t.file))].sort();
  if (!files.length) return null;
  const runner = ctx.packages.has("vitest") ? "npx vitest run" : ctx.packages.has("jest") ? "npx jest" : ctx.packages.has("mocha") ? "npx mocha" : ctx.packages.has("@playwright/test") ? "npx playwright test" : null;
  return runner ? `${runner} ${files.join(" ")}` : `npm test -- ${files.join(" ")}`;
}
