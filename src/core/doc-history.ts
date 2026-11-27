import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { gitArgs } from "./git-safe.js";

type Answer = { deletedIn?: string; renamedTo?: string } | null;

/**
 * What git knows of a path a document names that is no longer there: the commit that removed it and, when that
 * commit renamed it, the new name — read from the whole commit with rename detection, since a path filter hides
 * the new side of a rename. Each missing path costs one or two git processes, so the answers are kept beside
 * the manifest for the next incremental run: an answer depends on the history alone, so it holds while HEAD
 * does. A run outside a work tree (or one with no commit) spawns nothing — every question would have failed.
 */
export interface PathHistory {
  (path: string): Answer;
  /** Writes the answers this run learned; a no-op when nothing is new. */
  save(): void;
}

const CACHE_NAME = ".doc-history.json";
const FORMAT = 1;

interface CacheFile {
  format: number;
  head: string;
  answers: Record<string, Answer>;
}

export function gitPathHistory(root: string, cacheDir?: string): PathHistory | undefined {
  const run = (args: string[]) =>
    execFileSync("git", gitArgs(root, args), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  let head: string;
  try {
    head = run(["rev-parse", "--verify", "HEAD"]);
  } catch {
    return undefined;
  }
  const cachePath = cacheDir ? join(cacheDir, CACHE_NAME) : undefined;
  const known = new Map<string, Answer>();
  if (cachePath) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as Partial<CacheFile>;
      if (parsed.format === FORMAT && parsed.head === head && parsed.answers && typeof parsed.answers === "object") {
        for (const [p, a] of Object.entries(parsed.answers)) known.set(p, a);
      }
    } catch {
      /* no cache yet, or unreadable: every question is asked */
    }
  }
  let learned = false;
  const lookup = ((path: string): Answer => {
    if (known.has(path)) return known.get(path)!;
    let answer: Answer;
    try {
      const out = run(["log", "-1", "--diff-filter=D", "--format=%h %cs", "--", path]);
      if (!out) answer = null;
      else {
        const [commit, date] = out.split(" ");
        answer = { deletedIn: date ? `${commit} (${date})` : commit! };
        for (const line of run(["show", "-M", "--name-status", "--format=", commit!]).split("\n")) {
          const cols = line.split("\t");
          if (cols[0]?.startsWith("R") && cols[1] === path && cols[2]) {
            answer = { renamedTo: cols[2] };
            break;
          }
        }
      }
    } catch {
      // A failed or timed-out question is not an answer: not kept.
      return null;
    }
    known.set(path, answer);
    learned = true;
    return answer;
  }) as PathHistory;
  lookup.save = () => {
    if (!learned || !cachePath) return;
    try {
      const tmp = `${cachePath}.partial`;
      writeFileSync(tmp, JSON.stringify({ format: FORMAT, head, answers: Object.fromEntries(known) } satisfies CacheFile));
      renameSync(tmp, cachePath);
      learned = false;
    } catch {
      /* the cache is an optimization */
    }
  };
  return lookup;
}
