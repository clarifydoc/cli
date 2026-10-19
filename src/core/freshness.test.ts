import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assessFreshness, saveManifest, EXTRACTOR_VERSION } from "./manifest.js";

/**
 * Before this, the only staleness signal was "analyzed 3 hours ago", which says
 * nothing about whether the code moved. The manifest already held an mtime and
 * a hash per file.
 */
let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarifydoc-fresh-"));
  out = join(root, ".clarifydoc");
  mkdirSync(out, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function seed(files: Record<string, string>, version = EXTRACTOR_VERSION): Promise<void> {
  const entries: Record<string, { mtime: number; sha256: string }> = {};
  const { createHash } = await import("crypto");
  const { statSync } = await import("fs");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    writeFileSync(abs, body);
    entries[rel] = {
      mtime: statSync(abs).mtimeMs,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  await saveManifest(out, { version: 1, extractorVersion: version, entries });
}

describe("assessFreshness", () => {
  it("reports fresh when nothing moved", async () => {
    await seed({ "src/a.ts": "export const a = 1;\n" });
    const f = await assessFreshness(out, root);
    expect(f.state).toBe("fresh");
    expect(f.checked).toBe(1);
    expect(f.changed).toEqual([]);
  });

  it("names an edited file", async () => {
    await seed({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    writeFileSync(join(root, "src/a.ts"), "export const a = 99;\n");
    const f = await assessFreshness(out, root);
    expect(f.state).toBe("changed");
    expect(f.changed).toEqual(["src/a.ts"]);
    expect(f.removed).toEqual([]);
  });

  it("names a deleted file", async () => {
    await seed({ "src/a.ts": "export const a = 1;\n" });
    unlinkSync(join(root, "src/a.ts"));
    const f = await assessFreshness(out, root);
    expect(f.state).toBe("changed");
    expect(f.removed).toEqual(["src/a.ts"]);
  });

  it("tolerates a touched mtime when the content is identical", async () => {
    await seed({ "src/a.ts": "export const a = 1;\n" });
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n"); // rewrite, same bytes
    expect((await assessFreshness(out, root)).state).toBe("fresh");
  });

  it("distinguishes an older extractor from an absent manifest", async () => {
    await seed({ "src/a.ts": "x\n" }, "0.0.1-old");
    expect((await assessFreshness(out, root)).state).toBe("extractor-changed");
    rmSync(join(out, "manifest.json"));
    expect((await assessFreshness(out, root)).state).toBe("unknown");
  });

  it("caps the work and says the answer is sampled", async () => {
    await seed({ "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
    const f = await assessFreshness(out, root, { maxStats: 2 });
    expect(f.checked).toBe(2);
    expect(f.sampled).toBe(true);
  });
});

describe("assessFreshness through git", () => {
  const git = async (...args: string[]) => {
    const { execFileSync } = await import("child_process");
    return execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]).toString().trim();
  };

  it("names a file added after the analysis, never one discovery passed over, and a moved HEAD", async () => {
    await git("init", "-q");
    writeFileSync(join(root, ".gitignore"), ".clarifydoc/\n");
    // Present before the analysis but not in its manifest (a plugin skipped it).
    writeFileSync(join(root, "src/legacy.xml"), "<project/>\n");
    await seed({ "src/a.ts": "export const a = 1;\n" });
    await git("add", "-A");
    await git("commit", "-qm", "one");
    const analyzed = await git("rev-parse", "HEAD");
    const { loadManifestRaw } = await import("./manifest.js");
    const m = (await loadManifestRaw(out))!;
    await saveManifest(out, { ...m, revision: { commit: analyzed, branch: null } });

    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/c.ts"), "export const c = 3;\n"); // a directory the analysis never covered
    await git("add", "-A");
    await git("commit", "-qm", "two");

    const f = await assessFreshness(out, root);
    expect(f.state).toBe("changed");
    expect(f.added).toEqual(["src/b.ts"]);
    expect(f.head).toEqual({ analyzed, now: await git("rev-parse", "HEAD") });

    const { freshnessBanner } = await import("../mcp/tools/context.js");
    const banner = await freshnessBanner({ analysisDir: out, projectRoot: root, allowAnalyze: true } as never)();
    expect(banner).toMatch(/^⚠ Stale: 1 added, HEAD [0-9a-f]{8} → [0-9a-f]{8} since this analysis — clarifydoc_analyze refreshes it\.$/);
    expect((await assessFreshness(out, root, { git: false })).added).toEqual([]);
  });
});
