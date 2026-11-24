import { isAbsolute, relative, resolve } from "node:path";

/**
 * The absolute path of `rel` under `absRoot`, or null when `rel` — a string the analyzed
 * corpus wrote — could leave the root: climbing out by `..` (either separator), absolute,
 * home-relative, a drive letter, a UNC or `//host` path, or a NUL byte. Every reader that
 * turns such a string into a filesystem call asks this first; a refused path stays as
 * written in the output and is never read.
 */
export function insideRoot(absRoot: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  if (/^(?:[\\/]|~|[A-Za-z]:)/.test(rel)) return null;
  if (rel.split(/[\\/]+/).some((s) => s === "..")) {
    // A climb that stays inside (`a/../b`) is fine; resolve below decides.
    const root = resolve(absRoot);
    const abs = resolve(root, rel.replace(/\\/g, "/"));
    const back = relative(root, abs);
    if (back === ".." || back.startsWith("../") || back.startsWith("..\\") || isAbsolute(back)) return null;
    return abs;
  }
  const root = resolve(absRoot);
  const abs = resolve(root, rel.replace(/\\/g, "/"));
  const back = relative(root, abs);
  return back === ".." || back.startsWith("../") || isAbsolute(back) ? null : abs;
}
