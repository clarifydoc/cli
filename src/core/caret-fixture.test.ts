import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { runCarets } from "./caret-testkit.js";

/**
 * Fixture projects whose source carries caret assertions (`caret-assertions.ts`):
 * the linker's expectations sit beside the code they describe, written by hand.
 * A fixture joins this gate by naming itself in CARET_FIXTURES.
 */
const FIXTURES = resolve(__dirname, "../../test-fixtures");
const CARET_FIXTURES = ["sample-caret-assertions"];
const SOURCE = /\.(ts|js|py)$/;

function sourcesOf(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourcesOf(full, base, out);
    else if (SOURCE.test(name) || name === "package.json") out[relative(base, full).split("\\").join("/")] = readFileSync(full, "utf-8");
  }
  return out;
}

describe.each(CARET_FIXTURES)("caret assertions in %s", (name) => {
  it("every assertion passes, including a call that must stay unresolved", async () => {
    const run = await runCarets(sourcesOf(join(FIXTURES, name)));
    const bad = run.results.filter((r) => r.status !== "passed").map((r) => `${r.assertion.file}:${r.assertion.commentLine} ${r.assertion.raw.trim()} -> ${r.status} ${r.message ?? ""} ${(r.found ?? []).join(" | ")}`);
    expect(bad).toEqual([]);
    expect(run.results.length).toBeGreaterThanOrEqual(7);
    // At least one call is asserted to stay unlinked beside its namesake decoys.
    expect(run.results.some((r) => r.assertion.kind === "call" && r.assertion.text === "-> unresolved")).toBe(true);
  });
});
