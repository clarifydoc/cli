import { execFile } from "child_process";
import { byOrdinal } from "./ordinal.js";
import type { CoChangePair, FileChurnInfo, FileComplexityInfo, HotspotInfo } from "../types/analysis.js";
import { gitArgs } from "./git-safe.js";

/**
 * Git-history signals: per-file churn (commits, line deltas, recency, authors)
 * from ONE `git log --numstat` pass over a bounded window, and churn ×
 * complexity hotspots derived from it.
 *
 * Design constraints:
 *  - Graceful everywhere: not a repo, git missing, shallow clone (the
 *    application server clones `--depth 1` by default), or a timeout all
 *    yield a `skipped` result — never an analysis failure.
 *  - Renames are followed: walking newest-first, a commit that renames
 *    `old` to `new` makes every older mention of `old` count for `new`.
 *  - The window ends at HEAD's commit date, not today: an old checkout
 *    still has its history.
 *  - Authors are mailmap-aware (`%aN`): one identity per resolved name.
 *  - numstat paths are REPO-root-relative; when the analyzed root sits below
 *    the repo root (`--show-prefix` non-empty) the prefix is stripped so
 *    paths line up with the analysis' project-relative files[].
 *  - Only files still present in files[] are kept (case-insensitive fallback
 *    for corpora whose casing drifts between git and disk — classic Delphi).
 */

export interface GitHistoryOptions {
  /** git binary; defaults to $CLARIFYDOC_GIT then "git". */
  gitBin?: string;
  /** History window in months (default 24). */
  months?: number;
  /** Commit cap inside the window (default 10 000). */
  maxCommits?: number;
  /** Hard timeout per git invocation (default 30 s). */
  timeoutMs?: number;
}

/**
 * Per-file churn over the history window, or the reason history was skipped
 * (not a repository, shallow clone, git failure). A skip is never an error:
 * the analysis simply goes without churn and hotspots.
 */
export type GitHistoryResult =
  | { churn: FileChurnInfo[]; commitCount: number; coChange: CoChangePair[] }
  | { skipped: string };

/** Commits touching more analyzed files than this are not co-change evidence. */
const MEGA_COMMIT = 20;
const CO_CHANGE_MIN_COUNT = 3;
const CO_CHANGE_MIN_SCORE = 0.3;
const CO_CHANGE_CAP = 500;

const TOP_AUTHORS = 3;

/**
 * Run one git command with a timeout and a large output buffer, never
 * rejecting: failures come back as `ok: false` with the stderr text.
 */
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

/**
 * Collect per-file churn (commits, additions, deletions, top authors, last
 * touch) from `git log --numstat` over the last `months`.
 *
 * Paths from git are matched to `currentFiles` exactly, then
 * case-insensitively; history of files no longer present is dropped. Every git
 * call is bounded by `timeoutMs`.
 *
 * @param projectRoot - Directory inside the repository
 * @param currentFiles - Files in the analysis, as repo-relative posix paths
 * @param options - Window, commit cap, timeout and git binary
 * @returns Churn rows and the commit count, or a `skipped` reason
 */
export async function collectGitHistory(
  projectRoot: string,
  currentFiles: string[],
  options: GitHistoryOptions = {},
): Promise<GitHistoryResult> {
  const gitBin = options.gitBin ?? process.env.CLARIFYDOC_GIT ?? "git";
  const months = options.months ?? 24;
  const maxCommits = options.maxCommits ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const g = (args: string[]) => runGit(gitBin, gitArgs(projectRoot, args), timeoutMs);

  const inside = await g(["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out.trim() !== "true") return { skipped: "not a git repository" };
  const shallow = await g(["rev-parse", "--is-shallow-repository"]);
  if (shallow.ok && shallow.out.trim() === "true") {
    return { skipped: "shallow clone (no history; clone without --depth to enable)" };
  }
  const prefixRes = await g(["rev-parse", "--show-prefix"]);
  const prefix = prefixRes.ok ? prefixRes.out.trim().replace(/\\/g, "/") : "";

  const head = await g(["log", "-1", "--format=%cI"]);
  const headTime = head.ok && head.out.trim() ? Date.parse(head.out.trim()) : NaN;
  const since = new Date((Number.isFinite(headTime) ? headTime : Date.now()) - months * 30 * 86_400_000).toISOString().slice(0, 10);
  // \x01 record marker — never appears in author names or hashes.
  const log = await g([
    "log", "--numstat", "-M", `--max-count=${maxCommits}`, `--since=${since}`,
    "--pretty=format:%x01%H%x01%aN%x01%aI%x01%aE%x01%s", "--", ".",
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
    /** Commits that fixed something (`isFixCommit`), and the newest one's date. */
    fixes: number;
    lastFix?: string;
  }
  const byFile = new Map<string, Acc>();
  /** Identity (email) → the name it is shown by. */
  const names = new Map<string, string>();
  /** Older path → the path it was renamed to (followed to the newest). */
  const renamedTo = new Map<string, string>();
  const follow = (p: string): string => {
    let cur = p;
    for (let i = 0; i < 50 && renamedTo.has(cur); i++) cur = renamedTo.get(cur)!;
    return cur;
  };
  const pairs = new Map<string, number>();
  let commitFiles: string[] = [];
  const flushCommit = () => {
    const unique = [...new Set(commitFiles)].sort(byOrdinal);
    commitFiles = [];
    if (unique.length < 2 || unique.length > MEGA_COMMIT) return;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\u0000${unique[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  };
  let commitCount = 0;
  let author = "";
  let date = "";
  let fix = false;
  // Dedup guard: numstat lists each path once per commit, but a merge commit
  // shown with default settings lists none — nothing to guard there.
  for (const line of log.out.split("\n")) {
    if (line.startsWith("\x01")) {
      flushCommit();
      const parts = line.split("\x01");
      // The mailmap-resolved name is the identity; the email only stands in
      // for a commit with no name.
      const name = parts[2] ?? "";
      const email = (parts[4] ?? "").trim().toLowerCase();
      author = name.trim().toLowerCase() || email;
      if (!names.has(author)) names.set(author, name || email);
      date = parts[3]?.trim() ?? "";
      fix = isFixCommit(parts[5] ?? "");
      commitCount++;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let path = m[3]!;
    // C-style quoting for unusual characters — strip the quotes, keep the rest.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    // A rename: `src/{old => new}/x.ts` or `old.ts => new.ts`. This and every
    // older commit's mention of the old path count for the newest name.
    const renamed = renamePaths(path);
    if (renamed) {
      const [from, to] = renamed;
      path = follow(to);
      if (from !== path) renamedTo.set(from, path);
    } else {
      path = follow(path);
    }
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    const file = canonical.get(path) ?? lower.get(path.toLowerCase());
    if (!file) continue; // deleted since, or outside the analyzed set

    let acc = byFile.get(file);
    if (!acc) {
      byFile.set(file, (acc = { commits: 0, additions: 0, deletions: 0, lastTouched: date, authors: new Map(), fixes: 0 }));
    }
    acc.commits++;
    if (fix) {
      acc.fixes++;
      acc.lastFix ??= date;
    }
    commitFiles.push(file);
    if (m[1] !== "-") acc.additions += Number(m[1]);
    if (m[2] !== "-") acc.deletions += Number(m[2]);
    // git log is newest-first, so the first sighting is the most recent touch.
    acc.authors.set(author, (acc.authors.get(author) ?? 0) + 1);
  }

  flushCommit();
  const churn: FileChurnInfo[] = [...byFile.entries()]
    .map(([file, acc]) => {
      const ranked = [...acc.authors.entries()]
        .map(([id, n]) => [names.get(id) ?? id, n] as const)
        .sort((a, b) => b[1] - a[1] || byOrdinal(a[0], b[0]));
      let covered = 0;
      let busFactor = 0;
      for (const [, n] of ranked) {
        busFactor++;
        covered += n;
        if (covered * 2 > acc.commits) break;
      }
      return {
        file,
        commits: acc.commits,
        additions: acc.additions,
        deletions: acc.deletions,
        lastTouched: acc.lastTouched,
        authors: ranked.slice(0, TOP_AUTHORS).map(([name]) => name),
        authorCount: acc.authors.size,
        authorShares: ranked.slice(0, 5).map(([name, commits]) => ({ name, commits })),
        busFactor,
        ...(acc.fixes ? { fixes: acc.fixes, ...(acc.lastFix ? { lastFix: acc.lastFix } : {}) } : {}),
      };
    })
    .sort((a, b) => b.commits - a.commits || byOrdinal(a.file, b.file));

  const commitsOf = new Map(churn.map((c) => [c.file, c.commits]));
  const coChange: CoChangePair[] = [];
  for (const [key, count] of pairs) {
    if (count < CO_CHANGE_MIN_COUNT) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const score = count / Math.min(commitsOf.get(a) ?? count, commitsOf.get(b) ?? count);
    if (score < CO_CHANGE_MIN_SCORE) continue;
    coChange.push({ a, b, count, score: Math.round(Math.min(1, score) * 100) / 100 });
  }
  coChange.sort((x, y) => y.score - x.score || y.count - x.count || byOrdinal(x.a, y.a) || byOrdinal(x.b, y.b));

  return { churn, commitCount, coChange: coChange.slice(0, CO_CHANGE_CAP) };
}

/**
 * The two paths of a numstat rename entry: `src/{a => b}/x.ts` → `src/a/x.ts`,
 * `src/b/x.ts`; `old.ts => new.ts`; `{ => sub}/x.ts`. Null for a plain path.
 */
/**
 * A commit that fixed something, by its subject: a conventional `fix:` /
 * `fix(scope):` / `bugfix:` / `hotfix:`, a revert, "fix #12" / "fixes #12" /
 * "fixed #12", or a subject that starts with "Fix" — the defect history of
 * the files it touched.
 */
export function isFixCommit(subject: string): boolean {
  const s = subject.trim();
  return /^(?:fix|bugfix|hotfix)(?:\([^)]*\))?!?:/i.test(s) || /^revert\b/i.test(s) || /\bfix(?:e[sd])?\s+#\d+/i.test(s) || /^fix(?:e[sd])?\b/i.test(s);
}

export function renamePaths(entry: string): [string, string] | null {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(entry);
  if (brace) {
    const [, pre, from, to, post] = brace;
    const join = (mid: string) => `${pre}${mid}${post}`.replace(/\/\//g, "/").replace(/^\//, "");
    return [join(from!), join(to!)];
  }
  const plain = /^(.*) => (.*)$/.exec(entry);
  return plain ? [plain[1]!, plain[2]!] : null;
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
    .sort((a, b) => b.score - a.score || byOrdinal(a.file, b.file))
    .slice(0, top);
}
