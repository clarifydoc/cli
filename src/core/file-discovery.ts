import fg from "fast-glob";
import { resolve } from "path";
import type { Language } from "../types/analysis.js";

/** Map file extensions to languages */
const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".py": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".vue": "typescript", // Vue SFCs are parsed by extracting <script> then treating as TS/JS
  ".pas": "pascal",
  ".pp": "pascal",
  ".lpr": "pascal",
  ".dpr": "pascal",
  ".dpk": "pascal",
  ".dfm": "dfm",
};

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
  "**/*.min.js",
  "**/*.bundle.js",
  "**/*.d.ts",
];

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: Language;
}

export interface DiscoveryOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

/**
 * Discover all analyzable source files in a project directory.
 */
export async function discoverFiles(
  projectRoot: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveredFile[]> {
  const root = resolve(projectRoot);

  const sourcePatterns = Object.keys(EXTENSION_MAP).map(
    (ext) => `**/*${ext}`,
  );
  const patterns = options.include?.length ? options.include : sourcePatterns;
  const ignore = [...DEFAULT_IGNORE, ...(options.exclude ?? [])];

  const files = await fg(patterns, {
    cwd: root,
    ignore,
    absolute: false,
    dot: false,
  });

  let results: DiscoveredFile[] = [];

  for (const relativePath of files) {
    const ext = getExtension(relativePath);
    const language = EXTENSION_MAP[ext];
    if (!language) continue;

    results.push({
      absolutePath: resolve(root, relativePath),
      relativePath,
      language,
    });
  }

  // Sort for deterministic output
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (options.maxFiles && results.length > options.maxFiles) {
    results = results.slice(0, options.maxFiles);
  }

  return results;
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot >= 0 ? filePath.slice(lastDot) : "";
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
