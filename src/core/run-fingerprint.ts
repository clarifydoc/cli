import { execFile } from "child_process";
import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { GIT_SAFE_DIFF, gitArgs } from "./git-safe.js";

/**
 * What an analysis was made from besides the per-file hashes: the options it
 * ran with, the project's config, and the state of the whole git working
 * tree — the commit, every uncommitted change, and the untracked files.
 * Compose files, deployment manifests, config values and git history feed
 * the summary without a per-file manifest entry, so "no file reparsed" alone
 * cannot say a run would produce the same output; this, equal to the last
 * run's, can. Null outside a git repository (or when git fails): such a
 * project is never judged up to date.
 */

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("git", gitArgs(root, args), { maxBuffer: 256 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
      resolve(err ? null : stdout),
    ),
  );
}

export async function runFingerprint(projectRoot: string, inputs: { options: unknown; extraFiles?: readonly string[] }): Promise<string | null> {
  const head = await git(projectRoot, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const [diff, untracked] = await Promise.all([
    git(projectRoot, ["diff", "HEAD", "--no-color", ...GIT_SAFE_DIFF, "--binary", "--relative"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (diff === null || untracked === null) return null;
  const h = createHash("sha256");
  h.update(JSON.stringify(inputs.options ?? null));
  h.update("\0head\0").update(head.trim());
  h.update("\0diff\0").update(diff);
  // An untracked file is new or edited content git's diff does not show.
  const others = untracked.split("\0").filter(Boolean).sort();
  for (const f of others) {
    const s = await stat(join(projectRoot, f)).catch(() => null);
    h.update(`\0u\0${f}\0${s ? `${s.size}:${s.mtimeMs}` : "gone"}`);
  }
  // Inputs read from outside the tree (imported SARIF) or not tracked by git (the project config).
  for (const f of inputs.extraFiles ?? []) {
    h.update(`\0x\0${f}\0`);
    h.update(await readFile(f).catch(() => Buffer.from("missing")));
  }
  return h.digest("hex");
}
