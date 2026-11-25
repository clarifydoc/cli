import { readFile, writeFile, rename, stat } from "fs/promises";
import { join } from "path";
import { extractorStamp } from "./manifest.js";
import { readTextFile } from "./read-text-file.js";
import { byOrdinal } from "./ordinal.js";

/**
 * The candidate files the deployment readers opened and turned down, kept between incremental runs.
 * Templates are found by content, so a repository with hundreds of YAML and JSON files (translations,
 * fixtures) opens every one on every run, and a one-file update waits on those reads. A verdict that
 * depends on the file's text alone ("no template here") holds while the file's size and modification
 * time do — the manifest's own fast-path rule, taken before the read so a write in between only costs
 * a re-read. Only rejections are remembered: a file that yields facts is always read again, and so is
 * one whose verdict also depends on other files (a Helm template against its chart). The cache lives
 * beside the manifest and is stamped with `extractorStamp()`, so a changed reader starts empty.
 */
const CACHE_NAME = ".deploy-rejects.json";

type Stat = [size: number, mtimeMs: number];

interface CacheFile {
  extractorVersion: string;
  kinds: Record<string, Record<string, Stat>>;
}

export class DeployRejects {
  private readonly next: CacheFile["kinds"] = {};
  private readonly seen = new Map<string, Stat>();
  private constructor(
    private readonly absRoot: string,
    private readonly path: string | undefined,
    private readonly previous: CacheFile["kinds"],
  ) {}

  /** `reuse` is false for a run that reads everything again: it still writes the cache for the next one. */
  static async open(absRoot: string, outputDir: string | undefined, reuse: boolean): Promise<DeployRejects> {
    const path = outputDir ? join(outputDir, CACHE_NAME) : undefined;
    let previous: CacheFile["kinds"] = {};
    if (path && reuse) {
      try {
        const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<CacheFile>;
        if (parsed.extractorVersion === extractorStamp() && parsed.kinds && typeof parsed.kinds === "object") previous = parsed.kinds;
      } catch {
        // No cache yet, or unreadable: every candidate is read.
      }
    }
    return new DeployRejects(absRoot, path, previous);
  }

  /**
   * The text of each file, in order, read in parallel batches. `undefined` where the file could not be
   * read or was turned down last time and has not changed — both mean "nothing here" to the caller.
   */
  async readAll(kind: string, rels: readonly string[]): Promise<Array<string | undefined>> {
    const known = this.previous[kind] ?? {};
    const out: Array<string | undefined> = [];
    for (let i = 0; i < rels.length; i += 32) {
      out.push(...(await Promise.all(rels.slice(i, i + 32).map(async (rel) => {
        const abs = join(this.absRoot, rel);
        let now: Stat | undefined;
        try {
          const st = await stat(abs);
          now = [st.size, st.mtimeMs];
        } catch {
          return undefined;
        }
        const before = known[rel];
        if (before && before[0] === now[0] && before[1] === now[1]) {
          (this.next[kind] ??= {})[rel] = before;
          return undefined;
        }
        this.seen.set(`${kind}\0${rel}`, now);
        return readTextFile(abs).catch(() => undefined);
      }))));
    }
    return out;
  }

  /** The file's text alone says it has nothing for this reader. */
  reject(kind: string, rel: string): void {
    const at = this.seen.get(`${kind}\0${rel}`);
    if (at) (this.next[kind] ??= {})[rel] = at;
  }

  async save(): Promise<void> {
    if (!this.path) return;
    const kinds: CacheFile["kinds"] = {};
    for (const kind of Object.keys(this.next).sort(byOrdinal)) {
      kinds[kind] = Object.fromEntries(Object.entries(this.next[kind]!).sort(([a], [b]) => byOrdinal(a, b)));
    }
    const body: CacheFile = { extractorVersion: extractorStamp(), kinds };
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(body), "utf-8");
      await rename(tmp, this.path);
    } catch {
      // A cache that cannot be written is only a slower next run.
    }
  }
}

/** Without a cache directory, the same reads with nothing remembered. */
export async function readCandidates(rejects: DeployRejects | undefined, absRoot: string, kind: string, rels: readonly string[]): Promise<Array<string | undefined>> {
  if (rejects) return rejects.readAll(kind, rels);
  const out: Array<string | undefined> = [];
  for (let i = 0; i < rels.length; i += 32) {
    out.push(...(await Promise.all(rels.slice(i, i + 32).map((f) => readTextFile(join(absRoot, f)).catch(() => undefined)))));
  }
  return out;
}
