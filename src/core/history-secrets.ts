import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { isPlaceholderSecret, maskSecrets, SECRET_FORMATS } from "./security-scanner.js";
import { isTestFile } from "./test-file-detector.js";
import { GIT_SAFE_DIFF, gitArgs } from "./git-safe.js";

/**
 * Credentials in git history: a key committed once is leaked for as long as
 * the history exists, deleting it from the tree changes nothing. Every added
 * line of every commit (all branches, merges left out — their lines come from
 * the commits merged) is read for the fixed-shape credential formats the
 * working-tree scanner knows — cloud keys, tokens, private key blocks, a
 * password in a connection URL — never a guess from a variable name; test
 * files, whose fake keys are deliberate, and lockfiles are left out. Each is
 * kept once, at the commit that introduced it, masked; `inTree` says whether
 * the file still holds it (the working-tree scan reports those already).
 */

export interface HistorySecret {
  format: string;
  commit: string;
  date: string;
  file: string;
  line: number;
  /** The added line, the credential masked. */
  snippet: string;
  /** The file as it is now still holds the credential. */
  inTree: boolean;
}

export interface HistorySecretsReport {
  commits: number;
  truncated: boolean;
  findings: HistorySecret[];
}

const LOCKFILE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/;

/** Parse `git log -p -U0` output (commit headers prefixed with NUL) into the credentials its added lines carry. */
export function secretsInLog(log: string): Array<Omit<HistorySecret, "inTree"> & { raw: string }> {
  const out: Array<Omit<HistorySecret, "inTree"> & { raw: string }> = [];
  let commit = "";
  let date = "";
  let file = "";
  let line = 0;
  for (const text of log.split("\n")) {
    if (text.startsWith("\u0000")) {
      [commit, date] = text.slice(1).split(" ") as [string, string];
      file = "";
    } else if (text.startsWith("+++ ")) {
      file = text.startsWith("+++ b/") ? text.slice(6) : "";
    } else if (text.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    } else if (text.startsWith("+") && file && !LOCKFILE.test(file) && !isTestFile(file)) {
      const added = text.slice(1);
      for (const [format, re] of SECRET_FORMATS) {
        const m = re.exec(added);
        if (m && !isPlaceholderSecret(added)) out.push({ format, commit, date, file, line, snippet: maskSecrets(added.trim()).slice(0, 160), raw: m[0] });
      }
      line++;
    }
  }
  return out;
}

export async function scanHistorySecrets(root: string, opts: { maxCommits?: number; timeoutMs?: number } = {}): Promise<HistorySecretsReport | undefined> {
  const maxCommits = opts.maxCommits ?? 5000;
  const log = await new Promise<string | null>((resolve) => {
    const child = spawn("git", gitArgs(root, ["log", "--all", "--no-merges", "--no-color", ...GIT_SAFE_DIFF, "-p", "-U0", `--max-count=${maxCommits}`, "--format=%x00%h %cs"]), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      // A history too large to hold is read as far as 512 MB.
      if (size < 512 * 1024 * 1024) chunks.push(c);
      else child.kill();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 || chunks.length ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
  if (log === null) return undefined;
  const commits = (log.match(/^\u0000/gm) ?? []).length;
  // Newest first: the last sighting of a credential is the commit that introduced it.
  const byValue = new Map<string, Omit<HistorySecret, "inTree"> & { raw: string }>();
  for (const s of secretsInLog(log)) byValue.set(`${s.format}\u0000${s.raw}`, s);
  const findings: HistorySecret[] = [];
  for (const { raw, ...s } of byValue.values()) {
    let inTree = false;
    try {
      const p = join(root, s.file);
      inTree = existsSync(p) && readFileSync(p, "utf8").includes(raw);
    } catch {
      /* unreadable now: not in the tree as text */
    }
    findings.push({ ...s, inTree });
  }
  findings.sort((a, b) => Number(a.inTree) - Number(b.inTree) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { commits, truncated: commits >= maxCommits, findings: findings.slice(0, 500) };
}
