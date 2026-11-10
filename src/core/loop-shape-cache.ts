import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import { extractorStamp, type ManifestEntry } from "./manifest.js";
import type { LoopShape } from "./query-in-loop.js";
import { loopShapesOfFiles } from "./loop-shape-batch.js";

/**
 * The loops of each file's functions, kept between incremental runs by the
 * file's content hash (the manifest's `sha256`). `findQueriesInLoops` builds a
 * control-flow graph of every file holding a database call — most of its
 * time, and the same answer for a file whose bytes did not change. The cache
 * lives beside the manifest, is stamped with `extractorStamp()` like it, and
 * keeps only the files this run asked about.
 */
const CACHE_NAME = ".loop-shapes.json";

interface CacheFile {
  extractorVersion: string;
  files: Record<string, { sha256: string; shapes: LoopShape[] | null }>;
}

export async function openLoopShapeCache(
  outputDir: string,
  manifest: Readonly<Record<string, ManifestEntry>>,
  projectRoot: string,
): Promise<{ get: (files: readonly string[]) => Promise<Array<LoopShape[] | null | undefined>>; save: () => Promise<void> }> {
  const path = join(outputDir, CACHE_NAME);
  let previous: CacheFile["files"] = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<CacheFile>;
    if (parsed.extractorVersion === extractorStamp() && parsed.files && typeof parsed.files === "object") previous = parsed.files;
  } catch {
    // No cache yet, or unreadable: every graph is built.
  }
  const next: CacheFile["files"] = {};
  return {
    /** The loops of each file, in order: remembered ones as they are, the rest built together. */
    async get(files) {
      const out: Array<LoopShape[] | null | undefined> = new Array(files.length);
      const missing: number[] = [];
      files.forEach((file, i) => {
        const sha256 = manifest[file]?.sha256;
        const hit = previous[file];
        if (sha256 && hit && hit.sha256 === sha256) {
          next[file] = hit;
          out[i] = hit.shapes;
        } else {
          missing.push(i);
        }
      });
      const built = await loopShapesOfFiles(projectRoot, missing.map((i) => files[i]!));
      missing.forEach((i, at) => {
        const shapes = built[at];
        out[i] = shapes;
        const sha256 = manifest[files[i]!]?.sha256;
        // A file whose worker died has no answer to remember.
        if (sha256 && shapes !== undefined) next[files[i]!] = { sha256, shapes };
      });
      return out;
    },
    async save() {
      const body: CacheFile = { extractorVersion: extractorStamp(), files: next };
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(body), "utf-8");
      await rename(tmp, path);
    },
  };
}
