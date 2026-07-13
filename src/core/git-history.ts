import { execFile } from "child_process";
import type { FileChurnInfo, FileComplexityInfo, HotspotInfo } from "../types/analysis.js";

/**
 * Git-history signals: per-file churn (commits, line deltas, recency, authors)
 * from ONE `git log --numstat` pass over a bounded window, and churn ×
 * complexity hotspots derived from it.
 *
 * Design constraints:
 *  - Graceful everywhere: not a repo, git missing, shallow clone (the
 *    application server clones `--depth 1` by default), or a timeout all
 *    yield a `skipped` result — never an analysis failure.
 *  - `--no-renames` keeps parsing trivial; a renamed file's history restarts
 *    at the rename, which is acceptable for a hotspot signal.
 *  - numstat paths are REPO-root-relative; when the analyzed root sits below
 *    the repo root (`--show-prefix` non-empty) the prefix is stripped so
 *    paths line up with the analysis' project-relative files[].
 *  - Only files still present in files[] are kept (case-insensitive fallback
 *    for corpora whose casing drifts between git and disk — classic Delphi).
 */

export interface GitHistoryOptions {
  /** git binary; defaults to $REVERSEDOC_GIT then "git". */
  gitBin?: string;
  /** History window in months (default 24). */
  months?: number;
  /** Commit cap inside the window (default 10 000). */
  maxCommits?: number;
  /** Hard timeout per git invocation (default 30 s). */
  timeoutMs?: number;
}

export type GitHistoryResult =
  | { churn: FileChurnInfo[]; commitCount: number }
  | { skipped: string };

const TOP_AUTHORS = 3;

function runGit(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((res) => {
    execFile(
      bin,
      args,
      { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) =>
        res({ ok: !error, out: stdout ?? "", err: (stderr || error?.message || "").trim() }),
    );
  });
}

export async function collectGitHistory(
  projectRoot: string,
  currentFiles: string[],
  options: GitHistoryOptions = {},
): Promise<GitHistoryResult> {
  const gitBin = options.gitBin ?? process.env.REVERSEDOC_GIT ?? "git";
  const months = options.months ?? 24;
  const maxCommits = options.maxCommits ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const g = (args: string[]) => runGit(gitBin, ["-C", projectRoot, ...args], timeoutMs);

  const inside = await g(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") return { skipped: "not a git repository" };
  const shallow = await g(["rev-parse", "--is-shallow-repository"]);
  if (shallow.ok && shallow.out.trim() === "true") {
    return { skipped: "shallow clone (no history; clone without --depth to enable)" };
  }
  const prefixRes = await g(["rev-parse", "--show-prefix"]);
  const prefix = prefixRes.ok ? prefixRes.out.trim().replace(/\\/g, "/") : "";

  const since = new Date(Date.now() - months * 30 * 86_400_000).toISOString().slice(0, 10);
  // \x01 record marker — never appears in author names or hashes.
  const log = await g([
    "log", "--numstat", "--no-renames", `--max-count=${maxCommits}`, `--since=${since}`,
    "--pretty=format:%x01%H%x01%an%x01%aI", "--", ".",
  ]);
  if (!log.ok) return { skipped: `git log failed: ${log.err}` };

  // Canonical path index over the current tree (exact, then case-insensitive).
  const canonical = new Map<string, string>();
  const lower = new Map<string, string>();
  for (const f of currentFiles) {
    const n = f.replace(/\\/g, "/");
    canonical.set(n, f);
    if (!lower.has(n.toLowerCase())) lower.set(n.toLowerCase(), f);
  }

  interface Acc {
    commits: number;
    additions: number;
    deletions: number;
    lastTouched: string;
    authors: Map<string, number>;
  }
  const byFile = new Map<string, Acc>();
  let commitCount = 0;
  let author = "";
  let date = "";
  // Dedup guard: numstat lists each path once per commit, but a merge commit
  // shown with default settings lists none — nothing to guard there.
  for (const line of log.out.split("\n")) {
    if (line.startsWith("\x01")) {
      const parts = line.split("\x01");
      author = parts[2] ?? "";
      date = parts[3]?.trim() ?? "";
      commitCount++;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let path = m[3]!;
    // C-style quoting for unusual characters — strip the quotes, keep the rest.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    const file = canonical.get(path) ?? lower.get(path.toLowerCase());
    if (!file) continue; // deleted since, or outside the analyzed set

    let acc = byFile.get(file);
    if (!acc) {
      byFile.set(file, (acc = { commits: 0, additions: 0, deletions: 0, lastTouched: date, authors: new Map() }));
    }
    acc.commits++;
    if (m[1] !== "-") acc.additions += Number(m[1]);
    if (m[2] !== "-") acc.deletions += Number(m[2]);
    // git log is newest-first, so the first sighting is the most recent touch.
    acc.authors.set(author, (acc.authors.get(author) ?? 0) + 1);
  }

  const churn: FileChurnInfo[] = [...byFile.entries()]
    .map(([file, acc]) => ({
      file,
      commits: acc.commits,
      additions: acc.additions,
      deletions: acc.deletions,
      lastTouched: acc.lastTouched,
      authors: [...acc.authors.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_AUTHORS)
        .map(([name]) => name),
      authorCount: acc.authors.size,
    }))
    .sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file));

  return { churn, commitCount };
}

/**
 * Hotspots = normalized commit count × normalized total complexity, over files
 * that have BOTH signals. Normalization is within the project, so the score
 * ranks files against each other rather than against an absolute scale.
 */
export function computeHotspots(
  churn: FileChurnInfo[],
  complexity: FileComplexityInfo[],
  top = 50,
): HotspotInfo[] {
  const cxByFile = new Map<string, number>();
  for (const c of complexity) {
    cxByFile.set(c.filePath.toLowerCase(), c.totalComplexity);
  }
  const matched = churn
    .map((ch) => ({ ch, cx: cxByFile.get(ch.file.toLowerCase()) ?? 0 }))
    .filter((m) => m.ch.commits > 0 && m.cx > 0);
  if (matched.length === 0) return [];
  const maxCommits = Math.max(...matched.map((m) => m.ch.commits));
  const maxCx = Math.max(...matched.map((m) => m.cx));
  return matched
    .map(({ ch, cx }) => ({
      file: ch.file,
      score: Math.round((ch.commits / maxCommits) * (cx / maxCx) * 1000) / 1000,
      commits: ch.commits,
      totalComplexity: cx,
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, top);
}
