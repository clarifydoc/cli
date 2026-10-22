import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { byOrdinal } from "./ordinal.js";
import { basename, dirname, resolve, sep } from "path";
import { glob, LinkedFiles } from "./glob.js";
import type { Language } from "../types/analysis.js";
import { EXTENSION_TO_LANGUAGE, getLanguageForFile } from "../parsers/language-map.js";
import { CODE_LANGUAGES, NAMED_FILE_LANGUAGE, SOURCE_DIRS } from "../extractors/registry.js";
import { loadIgnorePatterns, isIgnored, ignoredDirectories } from "./clarifydoc-ignore.js";

/**
 * Files that hold secrets by their kind — skipped silently and reported
 * separately. Basename-targeted regexes, so a key file deep in the tree is
 * still excluded.
 */
const SENSITIVE_FILES: ReadonlyArray<RegExp> = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
  /(\.netrc|\.pgpass|\.htpasswd)$/i,
];

/**
 * Words that make a DATA file suspect (`secrets.yaml`, `credentials.json`,
 * `token.xml`). Not applied to code: `password-reset.controller.ts` and
 * `token-count-utils.ts` are source, and a hardcoded secret inside source is
 * the security scanner's to find (and mask), not a reason to hide the file.
 */
const SENSITIVE_NAMES: ReadonlyArray<RegExp> = [
  /\b(credential|secret|passwd|password|token|private_key)s?\b/i,
  /(aws_credentials|gcloud_credentials|service[._-]account)/i,
];

/** A directory that holds credentials by its name alone: `secrets/`, `credentials/`, `private_keys/`. */
const SENSITIVE_DIR = /^\.?(?:credential|secret|private_key)s?$/i;

/** A component's template (`manage-user-tokens.component.html`): the screen of a flow, not a store of what it handles. */
const PAGE_TEMPLATE = /\.(?:component|page|view|modal|dialog|partial)\.(?:html?|hbs|handlebars|erb|cshtml|razor|jspx?|liquid|twig|mustache|njk|ejs|pug)$/i;

/**
 * Whether a path looks like it holds a credential. A `.env`, a key or a
 * certificate never is read, whatever it is; a file named `secret`/`password`/
 * `token`/… is skipped only when it is data, not code (see {@link SENSITIVE_NAMES}).
 * Without a language the name rule always applies.
 *
 * @param relativePath - Posix path relative to the project root
 * @param language - The language discovery mapped the file to
 */
export function isSensitive(relativePath: string, language?: Language): boolean {
  if (SENSITIVE_FILES.some((p) => p.test(relativePath))) return true;
  if (language && CODE_LANGUAGES.has(language)) return false;
  const segments = relativePath.split(/[\\/]/);
  if (segments.slice(0, -1).some((d) => SENSITIVE_DIR.test(d))) return true;
  const base = segments[segments.length - 1]!;
  if (PAGE_TEMPLATE.test(base)) return false;
  // `password-reset.html`, `forgot_password.json`: a flow about a password, not one stored. The file's
  // own name decides — a migration directory named `…_password-reset-token/` holds a schema change.
  const name = base.replace(PASSWORD_FLOW, "");
  return SENSITIVE_NAMES.some((p) => p.test(name));
}

/** A password named with what is done to it — a page, a template, its strings. */
const PASSWORD_FLOW = /\b(?:reset|forgot|forgotten|change|update|recover|recovery|confirm|new|set)[-_ ]?passwords?\b|\bpasswords?[-_ ]?(?:reset|forgot|change|changed|update|recovery|policy|strength|expired)\b/gi;


/** Files that make a directory a project its build tool builds. */
const PROJECT_MANIFEST = /^(?:package\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|build\.sbt|CMakeLists\.txt|Makefile|Cargo\.toml|go\.mod|composer\.json|Gemfile|mix\.exs|pyproject\.toml|setup\.py|pubspec\.yaml|[^/]+\.(?:csproj|fsproj|vbproj|sln))$/i;

const manifestCache = new Map<string, boolean>();
function holdsManifest(dir: string): boolean {
  let hit = manifestCache.get(dir);
  if (hit === undefined) {
    try {
      hit = readdirSync(dir).some((name) => PROJECT_MANIFEST.test(name));
    } catch {
      hit = false;
    }
    manifestCache.set(dir, hit);
  }
  return hit;
}

/**
 * A `build/` directory a build tool writes: at the root, or beside the project's
 * manifest — unless it is a project itself (a NUKE / Cake build project with
 * its own `.csproj`). A `build` package deep in a source tree is source.
 */
function buildOutput(root: string, dir: string): boolean {
  if (basename(dir).toLowerCase() !== "build") return false;
  if (holdsManifest(dir)) return false;
  const parent = dirname(dir);
  return parent === root || holdsManifest(parent);
}

export const DEFAULT_IGNORE = [
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

/**
 * A source file discovery decided to analyze, with the language its extension
 * maps to.
 */
export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: Language;
}

/** Files to analyze plus what was deliberately skipped, so the CLI can report it. */
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

/**
 * Filters for `discoverFiles`: extra include/exclude globs (relative to the
 * root) and a cap on how many files to return.
 */
export interface DiscoveryOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
}

/**
 * Discover all analyzable source files in a project directory.
 *
 * Applies (in order): a glob walk with DEFAULT_IGNORE → symlink containment →
 * sensitive-file filter → .clarifydocignore gitignore semantics. Sensitive
 * files and refused symlinks are surfaced separately rather than dropped
 * silently so users can see what was excluded.
 *
 * Linked directories are never descended (see `glob.ts`); a linked file is
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
  // `build/` is decided per directory (`buildOutput`), not by name: a Java package or a
  // build project of its own may be called that.
  const ignore = [...DEFAULT_IGNORE.filter((p) => p !== "**/build/**"), ...(options.exclude ?? [])];
  const ignorePatterns = loadIgnorePatterns(root);
  const pruneIgnored = ignoredDirectories(root, ignorePatterns);
  const prune = (dir: string): boolean => (pruneIgnored?.(dir) ?? false) || buildOutput(root, dir);

  // Not following links, the walk would drop every linked file; list them
  // and decide per link below.
  const links = new LinkedFiles();
  const entries = await glob(patterns, {
    cwd: root,
    ignore,
    // Legacy Windows codebases (Delphi, VB) ship UNIT1.PAS / FORM1.DFM —
    // match extensions case-insensitively or a third of such repos vanishes.
    caseSensitiveMatch: false,
    links,
    prune,
  });

  // A skipped directory a plugin says holds source (`bin/` with a `dune`
  // file, or beside a `META6.json`): read it too, with the default ignores below it.
  if (!options.include?.length && SOURCE_DIRS.length > 0) {
    const seen = new Set(entries);
    const dirs = new Set<string>();
    for (const { dir, marker, markerMatches } of SOURCE_DIRS) {
      const markers = await glob(`**/${marker}`, {
        cwd: root,
        ignore: ignore.filter((p) => !marker.startsWith(p.replace(/^\*\*\//, "").replace(/\/\*\*$/, "") + "/")),
        prune,
      });
      for (const m of markers) {
        if (markerMatches && !markerMatches.test(readText(resolve(root, m)))) continue;
        const parent = m.slice(0, m.length - marker.length).replace(/\/$/, "");
        dirs.add(parent ? `${parent}/${dir}` : dir);
      }
    }
    for (const dir of dirs) {
      const inner = await glob(patterns, { cwd: resolve(root, dir), ignore, caseSensitiveMatch: false, links, prune });
      for (const e of inner) {
        const path = `${dir}/${e}`;
        if (!seen.has(path)) { seen.add(path); entries.push(path); }
      }
    }
  }

  let results: DiscoveredFile[] = [];
  const skippedSensitive: string[] = [];
  const skippedSymlinks: string[] = [];
  let realRoot: string | undefined;

  for (const relativePath of entries) {
    const absolutePath = resolve(root, relativePath);
    if (links.has(absolutePath)) {
      realRoot ??= realpathSync(root);
      if (!linksToFileInside(absolutePath, realRoot)) {
        skippedSymlinks.push(relativePath);
        continue;
      }
    }

    const language = getLanguageForFile(relativePath);
    if (!language) continue;

    if (isSensitive(relativePath, language)) {
      skippedSensitive.push(relativePath);
      continue;
    }

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

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
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

/** The lowercased extension including the dot, or empty when there is none. */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  return lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : "";
}

/** Get unique extensions found in a directory (for framework detection) */
export async function getFileExtensions(
  projectRoot: string,
): Promise<Set<string>> {
  const files = await glob("**/*.*", {
    cwd: resolve(projectRoot),
    ignore: DEFAULT_IGNORE,
    deep: 3,
  });

  const extensions = new Set<string>();
  for (const f of files) {
    const ext = getExtension(f);
    if (ext) extensions.add(ext);
  }
  return extensions;
}
