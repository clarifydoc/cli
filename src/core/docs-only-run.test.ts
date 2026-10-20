import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadManifest } from "./manifest.js";

/**
 * A change to documentation only: the next incremental run redoes doc drift on
 * the last analysis and nothing else, at the new revision — and a code change
 * after it is a full run again.
 */
describe("a docs-only re-run", () => {
  let dir: string;
  const root = () => join(dir, "app");
  const out = () => join(dir, "out");
  const git = (...args: string[]) => execFileSync("git", ["-C", root(), "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  const head = () => execFileSync("git", ["-C", root(), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const run = () => analyze({ projectRoot: root(), outputDir: out(), lsp: false, incremental: true });
  const summary = async () => JSON.parse(await readFile(join(out(), "project-summary.json"), "utf8")) as Record<string, unknown> & { docDrift?: { findings: Array<{ text: string }> }; analyzedAt: string; sourceRevision?: { commit: string } };
  /** The summary without what a docs-only run is allowed to change. */
  const facts = (s: Record<string, unknown>) => {
    const { analyzedAt: _a, docDrift: _d, sourceRevision: _r, ...rest } = s;
    return rest;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-docs-only-"));
    await mkdir(join(root(), "src"), { recursive: true });
    await writeFile(join(root(), "package.json"), JSON.stringify({ name: "app", dependencies: { express: "4.0.0" } }));
    await writeFile(join(root(), "src", "server.ts"), 'import express from "express";\nconst app = express();\napp.get("/api/orders", (req, res) => res.json([]));\n');
    await writeFile(join(root(), "README.md"), "The server is `src/server.ts`.\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "first");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("re-checks only the docs when only the docs changed, then is up to date, then runs in full for code", async () => {
    const first = await run();
    expect(first.docsOnly).toBeUndefined();
    const before = await summary();
    expect(before.docDrift?.findings ?? []).toEqual([]);
    const firstManifest = (await loadManifest(out()))!;
    expect(firstManifest.codeFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // An uncommitted edit to the README that names a file the tree lacks.
    await writeFile(join(root(), "README.md"), "The server is `src/server.ts`; orders are in `src/orders.ts`.\n");
    const edited = await run();
    expect(edited).toMatchObject({ docsOnly: true, fileCount: first.fileCount, routeCount: first.routeCount });
    const afterEdit = await summary();
    expect(afterEdit.docDrift!.findings.map((f) => f.text)).toEqual(["src/orders.ts"]);
    expect(facts(afterEdit)).toEqual(facts(before));
    expect(afterEdit.analyzedAt > before.analyzedAt).toBe(true);
    const editedManifest = (await loadManifest(out()))!;
    expect(editedManifest.codeFingerprint).toBe(firstManifest.codeFingerprint);
    expect(editedManifest.fingerprint).not.toBe(firstManifest.fingerprint);
    expect(editedManifest.entries).toEqual(firstManifest.entries);

    // Committing it moves HEAD, still docs only: the analysis now names the new commit.
    git("commit", "-qam", "docs");
    expect((await run()).docsOnly).toBe(true);
    expect((await summary()).sourceRevision?.commit).toBe(head());
    expect((await loadManifest(out()))!.revision?.commit).toBe(head());

    expect((await run()).upToDate).toBe(true);

    await writeFile(join(root(), "src", "server.ts"), 'import express from "express";\nconst app = express();\napp.get("/api/orders", (req, res) => res.json([]));\napp.post("/api/orders", (req, res) => res.json({}));\n');
    const code = await run();
    expect(code.docsOnly).toBeUndefined();
    expect(code.upToDate).toBeUndefined();
    expect(code.routeCount).toBe(first.routeCount + 1);
  }, 60_000);
});
