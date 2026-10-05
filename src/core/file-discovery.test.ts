import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "./file-discovery.js";

// A scanned repository controls its own symlinks: the app server analyzes
// whatever a git URL checks out. Discovery must neither read through a link out
// of the tree nor multiply a self-referencing one.
describe.skipIf(process.platform === "win32")("discoverFiles — symlinks", () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "clarifydoc-discovery-"));
    root = join(base, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(base, "outside", "dir"), { recursive: true });
    writeFileSync(join(base, "outside", "leak.py"), "TOKEN = 'not yours'\n");
    writeFileSync(join(base, "outside", "dir", "deep.py"), "x = 1\n");
    writeFileSync(join(root, "src", "real.py"), "a = 1\n");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const paths = async () => {
    const r = await discoverFiles(root);
    return { files: r.files.map((f) => f.relativePath), skipped: r.skippedSymlinks };
  };

  it("does not read a linked file that leaves the root", async () => {
    symlinkSync(join(base, "outside", "leak.py"), join(root, "src", "leak.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/real.py"]);
    expect(skipped).toEqual(["src/leak.py"]);
  });

  it("does not descend a linked directory, inside or outside the root", async () => {
    symlinkSync(join(base, "outside", "dir"), join(root, "src", "linkdir"));
    symlinkSync(join(root, "src"), join(root, "src", "loop"));
    const { files } = await paths();
    // Followed, `loop` alone would repeat every file at each of ~32 levels.
    expect(files).toEqual(["src/real.py"]);
  });

  it("skips a dangling link", async () => {
    symlinkSync(join(root, "src", "gone.py"), join(root, "src", "dangling.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/real.py"]);
    expect(skipped).toEqual(["src/dangling.py"]);
  });

  it("keeps a linked file that stays inside the root", async () => {
    symlinkSync("real.py", join(root, "src", "alias.py"));
    const { files, skipped } = await paths();
    expect(files).toEqual(["src/alias.py", "src/real.py"]);
    expect(skipped).toEqual([]);
  });

  it("checks containment against the resolved root when the root path is itself a link", async () => {
    symlinkSync(root, join(base, "repo-link"));
    symlinkSync("real.py", join(root, "src", "alias.py"));
    symlinkSync(join(base, "outside", "leak.py"), join(root, "src", "leak.py"));
    const r = await discoverFiles(join(base, "repo-link"));
    expect(r.files.map((f) => f.relativePath)).toEqual(["src/alias.py", "src/real.py"]);
    expect(r.skippedSymlinks).toEqual(["src/leak.py"]);
  });
});
