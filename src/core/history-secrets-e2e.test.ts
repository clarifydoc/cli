import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { scanHistorySecrets } from "./history-secrets.js";

/** A key committed, then deleted: gone from the tree, still in history. */
describe("credentials in git history", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "clarifydoc-hist-"));
    await mkdir(join(root, "src"), { recursive: true });
    git("init", "-q");
    await writeFile(join(root, "src", "config.ts"), 'export const key = "AKIA4Q2W7XZPLM3NB6RT";\n');
    git("add", ".");
    git("commit", "-qm", "add config");
    await writeFile(join(root, "src", "config.ts"), "export const key = process.env.AWS_KEY;\n");
    await writeFile(join(root, "src", "db.ts"), 'export const url = "postgres://app:s3cr3tpw@db:5432/app";\n');
    git("add", ".");
    git("commit", "-qm", "read the key from env; add db");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds both, says which the tree no longer holds, and never stores the secret", async () => {
    const r = (await scanHistorySecrets(root))!;
    expect(r.commits).toBe(2);
    expect(r.findings.map((f) => `${f.format} ${f.file}:${f.line} inTree=${f.inTree}`)).toEqual([
      "AWS access key src/config.ts:1 inTree=false",
      "database password in a connection URL src/db.ts:1 inTree=true",
    ]);
    expect(JSON.stringify(r)).not.toContain("AKIA4Q2W7XZPLM3NB6RT");
    expect(JSON.stringify(r)).not.toContain("s3cr3tpw");
  });
});
