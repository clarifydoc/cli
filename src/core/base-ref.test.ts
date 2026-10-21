import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { analysisAtRef } from "./base-ref.js";
import { loadReportSummary } from "./report-payload.js";
import { diffSurface } from "./surface-diff.js";

/** `diff --base <ref>`: the project at another commit, analyzed in a worktree that leaves nothing behind. */
describe("analysisAtRef", () => {
  let dir: string;
  const root = () => join(dir, "repo", "api");
  const git = (...args: string[]) => execFileSync("git", ["-C", join(dir, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-baseref-"));
    await mkdir(join(root(), "src"), { recursive: true });
    await writeFile(join(root(), "package.json"), JSON.stringify({ name: "api", dependencies: { express: "4.0.0" } }));
    await writeFile(join(root(), "src", "server.ts"), 'import express from "express";\nconst app = express();\napp.get("/api/cars", (req, res) => res.json([]));\napp.delete("/api/cars/:id", (req, res) => res.json({}));\n');
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    // The head drops a route and adds one, uncommitted.
    await writeFile(join(root(), "src", "server.ts"), 'import express from "express";\nconst app = express();\napp.get("/api/cars", (req, res) => res.json([]));\napp.post("/api/cars", (req, res) => res.json({}));\n');
    await analyze({ projectRoot: root(), outputDir: join(root(), ".clarifydoc", "api"), incremental: true, lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("analyzes the ref in a temporary worktree, seeded from the head, and reuses it next time", async () => {
    const head = join(root(), ".clarifydoc", "api");
    const first = await analysisAtRef(root(), "HEAD", { headAnalysisDir: head, cacheBase: join(head, ".base") });
    expect(first.reused).toBe(false);
    expect(first.dir).toBe(join(head, ".base", first.commit, "api"));
    const d = diffSurface(await loadReportSummary(first.dir), await loadReportSummary(head));
    const kinds = d.changes.map((c) => `${c.kind} ${c.route}`);
    expect(kinds.some((k) => k.includes("DELETE /api/cars/:id"))).toBe(true);
    expect(kinds.some((k) => k.includes("POST /api/cars"))).toBe(true);
    // Nothing left behind: no worktree, the working tree's edit intact.
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(await readFile(join(root(), "src", "server.ts"), "utf8")).toContain("app.post");
    expect((await analysisAtRef(root(), "HEAD", { headAnalysisDir: head, cacheBase: join(head, ".base") })).reused).toBe(true);
    await expect(analysisAtRef(root(), "no-such-ref", { cacheBase: join(head, ".base") })).rejects.toThrow(/No commit "no-such-ref"/);
    expect(existsSync(join(head, ".base", first.commit, "api", ".base"))).toBe(false);
  }, 120_000);
});
