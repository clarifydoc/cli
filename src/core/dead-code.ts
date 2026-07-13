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

/**
 * Directory segments that mark a subtree as generated or vendored by
 * convention alone — no barrel needed. Language-agnostic path tokens:
 * `generated` covers jOOQ/protobuf/openapi output (`…/jooq/generated/…`),
 * the rest are package-manager / vendoring conventions. Deliberately NOT
 * `gen` (a real word) or `external` (apps name integration code that).
 */
const CONVENTION_SEGMENT_RE =
  /^(?:generated|__generated__|codegen|node_modules|bower_components|jspm_packages|vendors?|third[-_]?party|thirdparty)$/i;

/** Static-asset containers; a `plugins`/`lib(s)` dir below one holds vendored
 *  browser libraries (`public/js/plugins/ckeditor`), not authored code. */
const ASSETS_SEGMENT_RE = /^(?:public|static|assets|wwwroot|htdocs)$/i;
const ASSET_LIB_SEGMENT_RE = /^(?:plugins|libs?)$/i;

/** Root dirs (posix, no trailing slash) marked generated/vendored by path
 *  convention. Shallowest-wins pruning happens in the caller's merge. */
export function conventionRoots(filePaths: string[]): string[] {
  const roots = new Set<string>();
  for (const f of filePaths) {
    const segs = f.replace(/\\/g, "/").split("/");
    let underAssets = false;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      if (CONVENTION_SEGMENT_RE.test(seg) || (underAssets && ASSET_LIB_SEGMENT_RE.test(seg))) {
        roots.add(segs.slice(0, i + 1).join("/"));
        break;
      }
      if (ASSETS_SEGMENT_RE.test(seg)) underAssets = true;
    }
  }
  return [...roots];
}

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

  // Merge barrel roots with convention-marked dirs (generated/, vendor/,
  // public/**/plugins/, …), keep only the shallowest — drop nested dirs.
  const dirs = [...new Set([...barrelDirs, ...conventionRoots(analyses.map((a) => a.filePath))])];
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
