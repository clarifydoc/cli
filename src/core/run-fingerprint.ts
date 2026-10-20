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
  return (await runFingerprints(projectRoot, inputs))?.full ?? null;
}

/** Prose a reader edits without touching what the analysis is made from. */
const PROSE = ["md", "markdown", "rst", "adoc", "asciidoc"];
const PROSE_RE = new RegExp(`\\.(?:${PROSE.join("|")})$`, "i");

/** True for a documentation file: only doc drift reads it. */
export function isProsePath(path: string): boolean {
  return PROSE_RE.test(path);
}

/**
 * `full` is {@link runFingerprint}; `code` is the same with every prose file
 * left out — the commit by its non-prose blobs rather than its id, the diff
 * and the untracked files without `.md` & co. A run whose `code` matches the
 * last one's while `full` does not changed only documentation.
 */
export async function runFingerprints(projectRoot: string, inputs: { options: unknown; extraFiles?: readonly string[] }): Promise<{ full: string; code: string } | null> {
  const head = await git(projectRoot, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const notProse = PROSE.map((ext) => `:(exclude,glob,icase)**/*.${ext}`);
  const [diff, codeDiff, tree, untracked] = await Promise.all([
    git(projectRoot, ["diff", "HEAD", "--no-color", ...GIT_SAFE_DIFF, "--binary", "--relative"]),
    git(projectRoot, ["diff", "HEAD", "--no-color", ...GIT_SAFE_DIFF, "--binary", "--relative", "--", ".", ...notProse]),
    git(projectRoot, ["ls-tree", "-r", "-z", "HEAD"]),
    git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (diff === null || codeDiff === null || tree === null || untracked === null) return null;
  const full = createHash("sha256");
  const code = createHash("sha256");
  const both = (text: string | Buffer) => {
    full.update(text);
    code.update(text);
  };
  both(JSON.stringify(inputs.options ?? null));
  full.update("\0head\0").update(head.trim());
  // `<mode> <type> <blob>\t<path>` per entry: the commit's content, prose aside.
  code.update("\0tree\0");
  for (const entry of tree.split("\0")) if (entry && !isProsePath(entry.slice(entry.indexOf("\t") + 1))) code.update(`${entry}\0`);
  full.update("\0diff\0").update(diff);
  code.update("\0diff\0").update(codeDiff);
  // An untracked file is new or edited content git's diff does not show.
  const others = untracked.split("\0").filter(Boolean).sort();
  for (const f of others) {
    const s = await stat(join(projectRoot, f)).catch(() => null);
    const line = `\0u\0${f}\0${s ? `${s.size}:${s.mtimeMs}` : "gone"}`;
    full.update(line);
    if (!isProsePath(f)) code.update(line);
  }
  // Inputs read from outside the tree (imported SARIF) or not tracked by git (the project config).
  for (const f of inputs.extraFiles ?? []) {
    both(`\0x\0${f}\0`);
    both(await readFile(f).catch(() => Buffer.from("missing")));
  }
  return { full: full.digest("hex"), code: code.digest("hex") };
}
