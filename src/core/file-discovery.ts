import fg from "fast-glob";
import { realpathSync, statSync } from "fs";
import { byOrdinal } from "./ordinal.js";
import { resolve, sep } from "path";
import { NO_SYMLINKS } from "./glob-safety.js";
import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE, getLanguageForFile } from "../parsers/language-map.js";
import { NAMED_FILE_LANGUAGE, SOURCE_DIRS } from "../extractors/registry.js";
import { loadIgnorePatterns, isIgnored } from "./clarifydoc-ignore.js";

/**
 * Files that may contain secrets — skipped silently and reported separately.
 * Ported from graphify-7 (detect.py:38-46): basename-targeted regexes so a key
 * file deep in the tree is still excluded.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /\b(credential|secret|passwd|password|token|private_key)s?\b/i,
  /(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(\.netrc|\.pgpass|\.htpasswd)$/i,
  /(aws_credentials|gcloud_credentials|service.account)/i,
];

export function isSensitive(relativePath: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(relativePath));
}


const DEFAULT_IGNORE = [
  "**/node_modules/**",
  // ClarifyDoc's own output, when it is written into the project.
  "**/.clarifydoc/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/bin/**",
  "**/obj/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  // Installed Python packages under a virtualenv of any other name (`env/`,
  // conda envs) — the node_modules of Python.
  "**/site-packages/**",
  "**/bower_components/**",
  "**/vendor/**",
  "**/target/**",
  "**/Pods/**",
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.d.ts",
];

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: Language;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  /** Files matching a sensitive-name pattern (.env, *.pem, id_rsa, ...). Skipped silently. */
  skippedSensitive: string[];
  /**
   * Symlinked source paths that were not read: the link leaves the project
   * root, dangles, or names something other than a regular file.
   */
  skippedSymlinks: string[];
}

export interface DiscoveryOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

/**
 * Discover all analyzable source files in a project directory.
 *
 * Applies (in order): fast-glob with DEFAULT_IGNORE → symlink containment →
 * sensitive-file filter → .clarifydocignore gitignore semantics. Sensitive
 * files and refused symlinks are surfaced separately rather than dropped
 * silently so users can see what was excluded.
 *
 * Linked directories are never descended (see `NO_SYMLINKS`); a linked file is
 * read only when it resolves to a regular file inside the root, so the alias
 * behaves as before while a link out of the tree reads nothing.
 */
export async function discoverFiles(
  projectRoot: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const root = resolve(projectRoot);

  const sourcePatterns = [
    ...Object.keys(EXTENSION_TO_LANGUAGE).map((ext) => `**/*${ext}`),
    // Extension-less source files a plugin claims by basename (Play `conf/routes`).
    ...[...NAMED_FILE_LANGUAGE.keys()].map((name) => `**/${name}`),
  ];
  const patterns = options.include?.length ? options.include : sourcePatterns;
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];

  const entries = await fg(patterns, {
    ...NO_SYMLINKS,
    cwd: root,
    ignore,
    absolute: false,
    dot: false,
    // Legacy Windows codebases (Delphi, VB) ship UNIT1.PAS / FORM1.DFM —
    // match extensions case-insensitively or a third of such repos vanishes.
    caseSensitiveMatch: false,
    // Not following links, fast-glob's file filter would drop every linked
    // file; keep the entries and decide per link below.
    onlyFiles: false,
    objectMode: true,
  });

  // A skipped directory a plugin says holds source (`bin/` with a `dune`
  // file, or beside a `META6.json`): read it too, with the default ignores below it.
  if (!options.include?.length && SOURCE_DIRS.length > 0) {
    const seen = new Set(entries.map((e) => e.path));
    const dirs = new Set<string>();
    for (const { dir, marker } of SOURCE_DIRS) {
      const markers = await fg(`**/${marker}`, {
        ...NO_SYMLINKS,
        cwd: root,
        ignore: ignore.filter((p) => !marker.startsWith(p.replace(/^\*\*\//, "").replace(/\/\*\*$/, "") + "/")),
        absolute: false,
        onlyFiles: true,
      });
      for (const m of markers) {
        const parent = m.slice(0, m.length - marker.length).replace(/\/$/, "");
        dirs.add(parent ? `${parent}/${dir}` : dir);
      }
    }
    for (const dir of dirs) {
      const inner = await fg(patterns, { ...NO_SYMLINKS, cwd: resolve(root, dir), ignore, absolute: false, dot: false, caseSensitiveMatch: false, onlyFiles: false, objectMode: true });
      for (const e of inner) {
        const path = `${dir}/${e.path}`;
        if (!seen.has(path)) { seen.add(path); entries.push({ ...e, path }); }
      }
    }
  }
  const ignorePatterns = loadIgnorePatterns(root);

  let results: DiscoveredFile[] = [];
  const skippedSensitive: string[] = [];
  const skippedSymlinks: string[] = [];
  let realRoot: string | undefined;

  for (const entry of entries) {
    const relativePath = entry.path;
    if (entry.dirent.isSymbolicLink()) {
      realRoot ??= realpathSync(root);
      if (!linksToFileInside(resolve(root, relativePath), realRoot)) {
        skippedSymlinks.push(relativePath);
        continue;
      }
    } else if (!entry.dirent.isFile()) {
      continue; // a directory named like a source file (`d3.js/`)
    }

    const language = getLanguageForFile(relativePath);
    if (!language) continue;

    if (isSensitive(relativePath)) {
      skippedSensitive.push(relativePath);
      continue;
    }

    const absolutePath = resolve(root, relativePath);
    if (isIgnored(absolutePath, root, ignorePatterns)) continue;

    results.push({
      absolutePath,
      relativePath,
      language,
    });
  }

  // Sort for deterministic output
  results.sort((a, b) => byOrdinal(a.relativePath, b.relativePath));
  skippedSensitive.sort();
  skippedSymlinks.sort(byOrdinal);

  if (options.maxFiles && results.length > options.maxFiles) {
    results = results.slice(0, options.maxFiles);
  }

  return { files: results, skippedSensitive, skippedSymlinks };
}

/** True when `linkPath` resolves to a regular file under `realRoot` (itself resolved). */
function linksToFileInside(linkPath: string, realRoot: string): boolean {
  try {
    const target = realpathSync(linkPath);
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!target.startsWith(prefix)) return false;
    return statSync(target).isFile();
  } catch {
    return false; // dangling link, or a loop the OS refuses to resolve
  }
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : "";
}

/** Get unique extensions found in a directory (for framework detection) */
export async function getFileExtensions(
  projectRoot: string,
): Promise<Set<string>> {
  const files = await fg("**/*.*", {
    ...NO_SYMLINKS,
    cwd: resolve(projectRoot),
    ignore: DEFAULT_IGNORE,
    absolute: false,
    deep: 3,
  });

  const extensions = new Set<string>();
  for (const f of files) {
    const ext = getExtension(f);
    if (ext) extensions.add(ext);
  }
  return extensions;
}
