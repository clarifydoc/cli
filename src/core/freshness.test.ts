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
