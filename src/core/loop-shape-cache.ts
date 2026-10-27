import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import { extractorStamp, type ManifestEntry } from "./manifest.js";
import { loopShapes, type LoopShape } from "./query-in-loop.js";

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
): Promise<{ get: (file: string) => Promise<LoopShape[] | null>; save: () => Promise<void> }> {
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
    async get(file) {
      const sha256 = manifest[file]?.sha256;
      const hit = previous[file];
      if (sha256 && hit && hit.sha256 === sha256) {
        next[file] = hit;
        return hit.shapes;
      }
      const shapes = await loopShapes(projectRoot, file);
      if (sha256) next[file] = { sha256, shapes };
      return shapes;
    },
    async save() {
      const body: CacheFile = { extractorVersion: extractorStamp(), files: next };
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(body), "utf-8");
      await rename(tmp, path);
    },
  };
}
