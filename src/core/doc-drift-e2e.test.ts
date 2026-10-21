import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A README that still names a file history renamed, and one it deleted. */
describe("doc drift with git history", () => {
  let dir: string;
  const root = () => join(dir, "app");
  const git = (...args: string[]) => execFileSync("git", ["-C", root(), "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-drift-"));
    await mkdir(join(root(), "src"), { recursive: true });
    await writeFile(join(root(), "package.json"), JSON.stringify({ name: "app" }));
    await writeFile(join(root(), "src", "cars.ts"), "export function buyCar() {\n  return 1;\n}\n// a body long enough for rename detection to see the same file\n");
    await writeFile(join(root(), "src", "legacy.ts"), "export const legacy = 1;\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "first");
    git("mv", "src/cars.ts", "src/car-service.ts");
    git("rm", "-q", "src/legacy.ts");
    git("commit", "-qm", "rename and delete");
    await writeFile(join(root(), "README.md"), "Cars live in `src/cars.ts`; `src/legacy.ts` holds the old code; `src/car-service.ts` is new.\n");
    await analyze({ projectRoot: root(), outputDir: join(dir, "out"), lsp: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the new file for a rename and the commit for a deletion", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    const f = s.docDrift!.findings.map((x) => `${x.text}: ${x.reason.replace(/[0-9a-f]{7,} \(\d{4}-\d\d-\d\d\)/, "<commit>")} (${x.confidence})`);
    expect(f).toEqual(["src/cars.ts: renamed to src/car-service.ts (EXTRACTED)", "src/legacy.ts: deleted in <commit> (EXTRACTED)"]);
  });
});
