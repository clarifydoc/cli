import fg from "fast-glob";
import { resolve } from "path";
import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE } from "../parsers/language-map.js";
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

function isSensitive(relativePath: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(relativePath));
}


const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.git/**",
  "**/bin/**",
  "**/obj/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
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
}

export interface DiscoveryOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

/**
 * Discover all analyzable source files in a project directory.
 *
 * Applies (in order): fast-glob with DEFAULT_IGNORE → sensitive-file filter →
 * .clarifydocignore gitignore semantics. Sensitive files are surfaced separately
 * rather than dropped silently so users can see what was excluded.
 */
export async function discoverFiles(
  projectRoot: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const root = resolve(projectRoot);

  const sourcePatterns = Object.keys(EXTENSION_TO_LANGUAGE).map(
    (ext) => `**/*${ext}`,
  );
  const patterns = options.include?.length ? options.include : sourcePatterns;
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];

  const files = await fg(patterns, {
    cwd: root,
    ignore,
    absolute: false,
    dot: false,
    // Legacy Windows codebases (Delphi, VB) ship UNIT1.PAS / FORM1.DFM —
    // match extensions case-insensitively or a third of such repos vanishes.
    caseSensitiveMatch: false,
  });

  const ignorePatterns = loadIgnorePatterns(root);

  let results: DiscoveredFile[] = [];
  const skippedSensitive: string[] = [];

  for (const relativePath of files) {
    const ext = getExtension(relativePath);
    const language = EXTENSION_TO_LANGUAGE[ext];
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
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skippedSensitive.sort();

  if (options.maxFiles && results.length > options.maxFiles) {
    results = results.slice(0, options.maxFiles);
  }

  return { files: results, skippedSensitive };
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
