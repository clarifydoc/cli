import type { ImportResolveContext } from "../../../types/language-plugin.js";
import { relativeModulePath } from "../shared/path-utils.js";
import { pythonStandardImport } from "./standard-library.js";

/**
 * Resolve a dotted Python module (`app.api.routes`) to a file in the project.
 *
 * Two things make this harder than the relative case. The module path is
 * absolute from a source root the analysis never learns (it may be the project
 * root, or `src/`, or a package directory), so every ancestor of the importing
 * file is tried as a candidate root, nearest first. And `from pkg import mod`
 * puts the module the caller means in the *specifier*, not the source — so
 * `pkg/<specifier>.py` is tried before `pkg.py` itself.
 *
 * Bounded work: (depth of the importing file) × 4 set lookups, no scan of the
 * project. A bare third-party import (`from fastapi import APIRouter`) simply
 * misses every candidate and returns null, which is the correct answer.
 * Leaf code: the static manifest uses it.
 */
export function resolvePythonModule(
  importingFile: string,
  src: string,
  hasFile: (path: string) => boolean,
  specifier: string | undefined,
): string | null {
  if (!/^[A-Za-z_][\w.]*$/.test(src)) return null;
  const modulePath = src.replace(/\./g, "/");
  const dir = importingFile.includes("/") ? importingFile.slice(0, importingFile.lastIndexOf("/")) : "";

  // Ancestors of the importing file, nearest first, then the project root.
  const roots: string[] = [];
  for (let d = dir; d !== ""; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    roots.push(d);
  }
  roots.push("");

  for (const root of roots) {
    const base = root ? `${root}/${modulePath}` : modulePath;
    const candidates = specifier
      ? [`${base}/${specifier}.py`, `${base}/${specifier}/__init__.py`, `${base}.py`, `${base}/__init__.py`]
      : [`${base}.py`, `${base}/__init__.py`];
    for (const candidate of candidates) {
      if (hasFile(candidate) && candidate !== importingFile) return candidate;
    }
  }
  return null;
}

/**
 * The project file a Python import names (`LanguagePluginManifest.resolveImport`):
 * `from clubs.models import Club` → `clubs/models.py`, `import league.sub.fixtures
 * as fx` → `league/sub/fixtures.py`, `from league import base` → `league/base.py`,
 * `from .sub import fixtures` → the module beside the importer. The standard
 * library and packages name no file (null). Leaf code: it reads only `ctx`.
 */
export function resolvePythonImport(importingFile: string, source: string, specifier: string | undefined, ctx: ImportResolveContext): string | null {
  if (!source) return null;
  const hasFile = (p: string) => ctx.files.has(p);
  if (!source.startsWith(".")) {
    if (pythonStandardImport(importingFile, source, hasFile)) return null;
    return resolvePythonModule(importingFile, source, hasFile, specifier);
  }
  const dir = importingFile.includes("/") ? importingFile.slice(0, importingFile.lastIndexOf("/")) : "";
  const joined = normalizeJoin(dir, relativeModulePath(source));
  // `from . import graph` / `from .pkg import mod` name the module in the specifier.
  const candidates = specifier ? [`${joined}/${specifier}.py`, `${joined}/${specifier}/__init__.py`] : [];
  candidates.push(`${joined}.py`, `${joined}/__init__.py`, `${joined}.pyw`);
  for (const candidate of candidates) {
    if (ctx.files.has(candidate)) return candidate;
  }
  return null;
}

/** Join a directory and a relative path, resolving `.` and `..` segments, posix-style. */
function normalizeJoin(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
