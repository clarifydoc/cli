import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";

/**
 * A run without `--incremental` reads every file, and leaves a manifest behind all the same: the
 * first incremental run after it reuses what it wrote. It used to find no manifest and read the
 * whole project a second time.
 */
describe("an incremental run after a plain one", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-plain-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-plain-out-"));
  afterAll(() => {
    for (const dir of [root, out]) rmSync(dir, { recursive: true, force: true });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ name: "league", dependencies: {} }));
  write("src/clubs.ts", "export function listClubs() {\n  return fetch('/api/v2/clubs');\n}\n");
  write("src/players.ts", "import { listClubs } from './clubs';\nexport function listPlayers() {\n  return listClubs();\n}\n");

  const run = (incremental: boolean) => analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, incremental, stableOutput: true });
  const entries = () => Object.keys((JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { entries: Record<string, unknown> }).entries);

  it("finds the plain run's manifest and reparses only the edited file", async () => {
    await run(false);
    expect(entries()).toEqual(["src/clubs.ts", "src/players.ts"]);
    write("src/players.ts", "import { listClubs } from './clubs';\nexport function listPlayers() {\n  return listClubs().then((r) => r);\n}\n");
    const next = await run(true);
    expect(next.changedFiles).toEqual(["src/players.ts"]);
  });

  it("is reread whole by another plain run, which keeps the manifest current", async () => {
    write("src/clubs.ts", "export function listClubs() {\n  return fetch('/api/v2/clubs?page=1');\n}\n");
    await run(false);
    const next = await run(true);
    expect(next.changedFiles).toEqual([]);
  });
});
