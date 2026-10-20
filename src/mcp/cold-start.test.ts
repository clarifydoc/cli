/**
 * Cold start: a read-only MCP server (the one the VS Code extension publishes)
 * still bootstraps a project that has never been analyzed, and never competes
 * with an analysis another process is already running.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, cp, stat } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, join, resolve } from "path";
import { AnalysisStore, MissingAnalysisError, coldStartScopeRefusal, unsafeColdStartRoot } from "./store.js";
import { locateProjectRoot } from "./server.js";
import { acquireAnalysisLock } from "../core/analysis-lock.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-cold-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function storeFor(
  opts: { allowAnalyze?: boolean; allowColdStart?: boolean; analysisDir?: string; coldStartRefusal?: string } = {},
) {
  return new AnalysisStore({
    projectRoot: root,
    analysisDir: opts.analysisDir ?? join(root, ".clarifydoc", basename(root)),
    allowAnalyze: opts.allowAnalyze ?? false,
    allowColdStart: opts.allowColdStart,
    coldStartRefusal: opts.coldStartRefusal,
  });
}

describe("MCP cold start", () => {
  it("analyzes once for a project with no analysis, even read-only", async () => {
    await writeFile(join(root, "app.py"), "def hello():\n    return 1\n", "utf-8");

    const store = storeFor();
    const loaded = await store.load();

    expect(loaded.summary.files).toContain("app.py");
    // ...and the analysis it just wrote keeps itself out of git.
    expect((await stat(join(store.analysisDir, ".gitignore"))).size).toBeGreaterThan(0);
  }, 120_000);

  it("refuses when cold start is off, naming the path it expected", async () => {
    const store = storeFor({ allowColdStart: false });
    await expect(store.load()).rejects.toThrow(MissingAnalysisError);
    await expect(store.load()).rejects.toThrow(/No analysis found at/);
  });

  it("honours cold start being off even when re-analysis is allowed", async () => {
    // --no-cold-start on its own must still forbid the unasked-for first scan;
    // it used to be ignored unless --no-auto-analyze was passed as well.
    await writeFile(join(root, "app.py"), "def hello():\n    return 1\n", "utf-8");
    const store = storeFor({ allowAnalyze: true, allowColdStart: false });
    await expect(store.load()).rejects.toThrow(MissingAnalysisError);
    // Explicitly asking still works — that is the difference from read-only.
    await store.refresh({ full: false });
    expect((await store.load()).summary.files).toContain("app.py");
  }, 120_000);

  it("waits for an analysis another process is running instead of scanning too", async () => {
    const analysisDir = join(root, ".clarifydoc", basename(root));
    const lock = await acquireAnalysisLock(analysisDir, "test-holder");
    expect(lock).not.toBeNull();

    const store = storeFor({ analysisDir });
    const loading = store.load();

    // The "other run" finishes: its summary appears, then it drops the lock.
    setTimeout(() => {
      void (async () => {
        await cp(join("test-output", "sample-erlang-app"), analysisDir, { recursive: true });
        await lock!.release();
      })();
    }, 150);

    const loaded = await loading;
    expect(loaded.summary.files.length).toBeGreaterThan(0);
    // It waited rather than analyzing: the temp project has no source files at
    // all, so anything it produced itself would have been empty.
  }, 30_000);
});

describe("MCP cold start refuses a root that is not a project", () => {
  it("never scans the home directory or a filesystem root unasked", () => {
    expect(unsafeColdStartRoot(homedir())).toMatch(/home directory/);
    expect(unsafeColdStartRoot(resolve("/"))).toMatch(/filesystem root/);
    expect(unsafeColdStartRoot(join(homedir(), "src", "app"))).toBeNull();
  });

  it("refuses with the reason and the fix, but still analyzes when asked", async () => {
    await writeFile(join(root, "app.py"), "def hello():\n    return 1\n", "utf-8");
    const store = storeFor({ allowAnalyze: true, coldStartRefusal: `${root} is not inside a project` });
    await expect(store.load()).rejects.toThrow(MissingAnalysisError);
    await expect(store.load()).rejects.toThrow(/is not inside a project.*clarifydoc mcp <path>/);
    await store.refresh({ full: false });
    expect((await store.load()).summary.files).toContain("app.py");
  }, 120_000);

  it("says whether the root came from a marker or is the fallback", async () => {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "src", "deep"), { recursive: true });
    expect(locateProjectRoot(join(root, "src", "deep"))).toEqual({ root, marked: true });
  });
});

describe("MCP cold start sizes the tree first", () => {
  afterEach(() => {
    delete process.env.CLARIFYDOC_MCP_COLD_START_MAX_FILES;
  });

  it("refuses a folder with no source in a language it reads, and says what to ask", async () => {
    await writeFile(join(root, "notes.txt"), "hello\n");
    const store = storeFor({ allowAnalyze: true });
    await expect(store.load()).rejects.toThrow(/Not analyzing automatically: .* holds no file in a language ClarifyDoc reads\. Ask the user where the project's source is/);
  });

  it("refuses a tree past the cap, naming the folders that hold the most, and analyzes when asked", async () => {
    process.env.CLARIFYDOC_MCP_COLD_START_MAX_FILES = "3";
    await mkdir(join(root, "legacy", "lib"), { recursive: true });
    await mkdir(join(root, "app"), { recursive: true });
    for (let i = 0; i < 3; i++) await writeFile(join(root, "legacy", "lib", `v${i}.py`), "x = 1\n");
    await writeFile(join(root, "app", "main.py"), "def main():\n    return 1\n");
    const refusal = await coldStartScopeRefusal(root);
    expect(refusal).toMatch(/holds 4 source files, more than the 3 a first analysis takes on unasked/);
    expect(refusal).toContain("the most files are in legacy/ 3, app/ 1");
    expect(refusal).toContain("`.clarifydocignore`");

    const store = storeFor({ allowAnalyze: true });
    await expect(store.load()).rejects.toThrow(MissingAnalysisError);
    await store.refresh({ full: false });
    expect((await store.load()).summary.files).toContain("app/main.py");
  }, 120_000);

  it("leaves a run the user scoped with maxFiles alone", async () => {
    process.env.CLARIFYDOC_MCP_COLD_START_MAX_FILES = "1";
    await writeFile(join(root, "a.py"), "x = 1\n");
    await writeFile(join(root, "b.py"), "y = 1\n");
    expect(await coldStartScopeRefusal(root)).toMatch(/holds 2 source files/);
    expect(await coldStartScopeRefusal(root, { maxFiles: 10 })).toBeNull();
  });
});
