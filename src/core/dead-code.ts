import type { FileAnalysis } from "../types/analysis.js";

/**
 * Detect generated/library "barrel" roots and the unused files within them.
 *
 * Motivation: code generators (kubb, openapi-generator, GraphQL codegen, …)
 * emit a large tree of files plus an `index.ts` barrel that re-exports
 * everything. Consumers import only a handful directly, so the vast majority
 * of generated files are dead — but a naive "no importers" check fails because
 * each file *is* referenced by its barrel.
 *
 * Approach:
 *   1. Identify barrel directories — a directory whose `index.*` re-exports many
 *      siblings (`export { x } from "./x"`). The shallowest such directory is
 *      treated as a generated root (its nested barrels are subsumed).
 *   2. Mark a file "used" if it's reachable, by following import edges, from any
 *      file OUTSIDE the generated roots. Re-exports do NOT create import edges
 *      (see imports-exports.ts), so a barrel never keeps its siblings alive —
 *      only a real consumer outside the tree does.
 *   3. Unused = files under a generated root that nothing outside reaches.
 *
 * Scoping to the generated subtree means app code can never be flagged, even
 * when its own entry points are reached via dynamic import.
 */

const BARREL_RE = /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MIN_REEXPORTS = 5;

export interface UnusedCodeResult {
  /** Shallowest barrel directories (posix paths, no trailing slash). */
  generatedRoots: string[];
  /** Files under a generated root not reachable from any non-generated file. */
  unusedFiles: string[];
}

function dirOf(filePath: string): string {
  const p = filePath.replace(/\\/g, "/");
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

export function analyzeUnusedCode(
  analyses: FileAnalysis[],
  componentGraph: Record<string, string[]>,
): UnusedCodeResult {
  // ── 1. Candidate barrel directories ──
  const barrelDirs = new Set<string>();
  for (const a of analyses) {
    if (!BARREL_RE.test(a.filePath.replace(/\\/g, "/"))) continue;
    const reexports = a.exports.filter((e) => e.kind === "re-export").length;
    if (reexports >= MIN_REEXPORTS) barrelDirs.add(dirOf(a.filePath));
  }

  // Keep only the shallowest roots — drop any dir nested under another.
  const dirs = [...barrelDirs];
  const generatedRoots = dirs
    .filter((r) => r && !dirs.some((o) => o !== r && r.startsWith(o + "/")))
    .sort();

  if (generatedRoots.length === 0) {
    return { generatedRoots: [], unusedFiles: [] };
  }

  const isGenerated = (f: string): boolean => {
    const p = f.replace(/\\/g, "/");
    return generatedRoots.some((r) => p === r || p.startsWith(r + "/"));
  };

  // ── 2. Reachability from non-generated files over import edges ──
  const allFiles = analyses.map((a) => a.filePath);
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const f of allFiles) {
    if (!isGenerated(f)) {
      visited.add(f);
      queue.push(f);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const f = queue[qi++]!;
    for (const t of componentGraph[f] ?? []) {
      if (!visited.has(t)) {
        visited.add(t);
        queue.push(t);
      }
    }
  }

  // ── 3. Unused = generated files nothing outside reaches ──
  const unusedFiles = allFiles.filter((f) => isGenerated(f) && !visited.has(f)).sort();

  return { generatedRoots, unusedFiles };
}
