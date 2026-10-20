import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdir } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { promisify } from "util";
import { loadManifest, saveManifest } from "./manifest.js";
import { GIT_SAFE_CONFIG } from "./git-safe.js";

const run = promisify(execFile);

/**
 * A new git worktree starts from the main checkout's analysis instead of from
 * nothing: before an incremental run with no manifest of its own, the main
 * worktree's per-file JSON and manifest are copied in. The run then hashes
 * every file — the mtimes differ — and reparses only what differs between
 * the two checkouts. Nothing is shared afterwards: each worktree owns its
 * analysis, and a manifest from another extractor version is never copied.
 */

export interface WorktreeSeed {
  /** The analysis directory copied from. */
  from: string;
  files: number;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await run("git", [...GIT_SAFE_CONFIG, ...args], { cwd, encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Where the main checkout keeps the analysis of the same project, when
 * `projectRoot` sits in a linked worktree and `outputDir` lies inside it.
 * The output directory's last segment follows the project's name, as
 * `analyze -o` lays it out.
 */
export async function mainWorktreeAnalysisDir(projectRoot: string, outputDir: string): Promise<string | null> {
  const root = resolve(projectRoot);
  const out = resolve(outputDir);
  const rel = relative(root, out);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const common = await git(root, ["rev-parse", "--git-common-dir"]);
  if (!top || !gitDir || !common || resolve(top, common) === resolve(gitDir)) return null;
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  const main = list?.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  if (!main || resolve(main) === resolve(top)) return null;
  const mainProject = join(main, relative(resolve(top), root));
  const mainOut = basename(rel) === basename(root) ? join(mainProject, dirname(rel), basename(mainProject)) : join(mainProject, rel);
  return existsSync(mainOut) ? mainOut : null;
}

/** Seed `outputDir` from the main worktree's analysis; null when there is nothing to seed or no need. */
export async function seedFromMainWorktree(projectRoot: string, outputDir: string): Promise<WorktreeSeed | null> {
  if (existsSync(join(outputDir, "manifest.json"))) return null;
  const from = await mainWorktreeAnalysisDir(projectRoot, outputDir);
  if (!from) return null;
  const manifest = await loadManifest(from);
  if (!manifest) return null;
  let files = 0;
  const keys = Object.keys(manifest.entries);
  const step = 32;
  for (let i = 0; i < keys.length; i += step) {
    await Promise.all(
      keys.slice(i, i + step).map(async (key) => {
        const src = join(from, `${key}.json`);
        if (!existsSync(src)) return;
        const dst = join(outputDir, `${key}.json`);
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
        files++;
      }),
    );
  }
  // Only entries whose JSON came along (a missing one would be a cache miss
  // anyway), and with no mtime: another checkout's mtime proves nothing, so
  // every file is hashed against the main checkout's content.
  const entries = Object.fromEntries(
    Object.entries(manifest.entries)
      .filter(([key]) => existsSync(join(outputDir, `${key}.json`)))
      .map(([key, e]) => [key, { mtime: -1, sha256: e.sha256 }]),
  );
  await saveManifest(outputDir, { version: 1, extractorVersion: manifest.extractorVersion, entries });
  return { from, files };
}
