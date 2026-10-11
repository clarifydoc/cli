import { readFile } from "fs/promises";
import { byOrdinal } from "./ordinal.js";
import { resolve, join, dirname } from "path";
import { glob } from "./glob.js";
import type {
  ExternalPackage,
  PackageEcosystem,
  FrameworkDetection,
  FileAnalysis,
} from "../types/analysis.js";
import type { DeclaredPackage, PackageManifestSpec } from "../types/language-plugin.js";
import {
  classifyKnownPackage,
  packageEcosystemsFor,
  packageMatchingFor,
  PACKAGE_MANAGERS,
  type KnownPackageEntry,
} from "../extractors/registry.js";

/**
 * Project-wide third-party dependency inventory.
 *
 * Where `framework-detector.ts` answers "is framework X present?" from a fixed
 * allowlist, this module answers the broader question: *what is the
 * full external surface of this codebase, and how much of it is actually live?*
 * It (1) reads every registered manifest format for declared dependencies,
 * (2) buckets each into a functional category, (3) cross-references the
 * declarations against the imports in analyzed source to mark used/unused, and
 * (4) derives framework detections from the packages it recognises. Every
 * ecosystem-specific part — manifest parsers, how an import names a package —
 * belongs to the plugin owning the package manager (`PackageManagerSpec`).
 *
 * Everything here is project-level (it never touches per-file `FileAnalysis`
 * output), so changes do not require an `EXTRACTOR_VERSION` bump.
 */

// ─── Classification ───────────────────────────────────────────────────────
// The core holds NO hardcoded package names: each language plugin contributes
// its ecosystem's packages via `meta.knownPackages`, aggregated by the registry
// into `classifyKnownPackage`. Only ecosystem-agnostic name-shape heuristics
// (the long tail: `@types/*`, `*-eslint`, bundler/test names) live here.

/**
 * Categorise a package: plugin-contributed exact hit first (also tried on the
 * trailing coordinate segment so `gorm.io/gorm` / `group:artifact` resolve),
 * then generic name-shape heuristics, else "other". Carries the framework too.
 */
function classify(name: string): KnownPackageEntry {
  const lower = name.toLowerCase();
  // `@types/*` are TypeScript stubs — never the framework they shadow
  // (`@types/express` must not become "express"/framework). Check before the
  // segment fallback below, which would otherwise split off the tail name.
  if (lower.startsWith("@types/")) return { category: "types" };

  const direct = classifyKnownPackage(lower);
  if (direct) return direct;

  // Try the trailing coordinate segment (Maven group:artifact, Go host/path,
  // dotted namespace). Skip npm `@scope/pkg` — its tail is a short name that
  // spuriously collides with unrelated packages.
  if (!lower.startsWith("@")) {
    const seg = lower.split(/[/:]/).pop();
    if (seg && seg !== lower) {
      const bySeg = classifyKnownPackage(seg);
      if (bySeg) return bySeg;
    }
  }

  // Generic name-shape heuristics for the long tail.
  if (lower.endsWith("-types") || lower.startsWith("types-")) return { category: "types" };
  if (/(^|[-_./])eslint|prettier|stylelint|tslint|rubocop|(^|[-_])lint($|[-_])/.test(lower)) return { category: "lint" };
  if (/(^|[-_./])(webpack|rollup|vite|esbuild|babel|parcel|gulp|grunt|swc)($|[-_./])/.test(lower)) return { category: "build" };
  if (/(^|[-_./])(test|tests|jest|vitest|mocha|jasmine|cypress|pytest|junit|spec|mock)($|[-_./])/.test(lower)) return { category: "testing" };
  if (/(^|[-_./])(orm|sequelize|hibernate|sqlalchemy)($|[-_./])/.test(lower)) return { category: "orm" };
  if (/(^|[-_./])(logger|logging)($|[-_./])/.test(lower)) return { category: "logging" };
  return { category: "other" };
}

// ─── Manifest discovery ────────────────────────────────────────────────────
// Every manifest format belongs to the plugin that owns its package manager
// (`plugins/<lang>/package-manifests.ts`, aggregated by the registry into
// PACKAGE_MANAGERS); core only walks the roots and reads the files. The one
// format no language owns — `.gitmodules` — is read here.

const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/bin/**", "**/obj/**", "**/vendor/**"];

async function readIf(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * `.gitmodules` — vendored submodules as declared dependencies. The package
 * name is the remote repo's basename (stable identity across checkouts); the
 * recorded "version" is null (submodules pin by commit, not by version).
 */
function parseGitmodules(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let path: string | null = null;
  let url: string | null = null;
  const flush = () => {
    if (!path && !url) return;
    const fromUrl = url?.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/i, "");
    const fromPath = path?.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop();
    const name = fromUrl || fromPath;
    if (name) out.push({ name, version: null, ecosystem: "git", scope: "prod", declaredIn });
    path = null;
    url = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[submodule\b/.test(line)) {
      flush();
      continue;
    }
    const kv = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/);
    if (kv) {
      if (kv[1] === "path") path = kv[2]!;
      else url = kv[2]!;
    }
  }
  flush();
  return out;
}

/** The packages one manifest format declares at one root (`rel`: the root, relative to the project). */
async function readManifest(absRoot: string, rel: string, spec: PackageManifestSpec): Promise<DeclaredPackage[]> {
  const files = spec.glob
    ? (await glob([...spec.files], { cwd: absRoot, ignore: IGNORE, deep: spec.glob.deep, absolute: false }))
        .slice(0, spec.glob.limit)
    : spec.files;
  const out: DeclaredPackage[] = [];
  for (const path of files) {
    const text = await readIf(join(absRoot, path));
    if (!text) continue;
    out.push(...await spec.parse(text, {
      declaredIn: rel ? `${rel}/${path}` : path,
      path,
      readSibling: (name) => readIf(join(absRoot, dirname(path), name)),
    }));
    if (spec.firstOnly) break;
  }
  return out;
}

/** Parse all dependencies declared at a single root directory. */
async function collectAtRoot(absRoot: string, rel: string): Promise<DeclaredPackage[]> {
  const out: DeclaredPackage[] = [];
  for (const manager of PACKAGE_MANAGERS) {
    for (const spec of manager.manifests) out.push(...await readManifest(absRoot, rel, spec));
  }
  // Vendored git submodules — the de-facto dependency channel for ecosystems
  // without a package manager (Delphi, plain C, game engines): the library IS
  // an external dependency even though its source sits inside the repo.
  const gitmodules = await readIf(join(absRoot, ".gitmodules"));
  if (gitmodules) out.push(...parseGitmodules(gitmodules, rel ? `${rel}/.gitmodules` : ".gitmodules"));
  return out;
}

/**
 * Collect, de-duplicate, and categorise every declared dependency across the
 * analyzed root and each sub-project root. Dedup key is `<ecosystem> <name>`
 * (a space can't appear in either half); first declaration wins for
 * version/location, scope upgrades dev→prod if it appears as a prod dep anywhere.
 */
export async function collectExternalPackages(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<ExternalPackage[]> {
  const root = resolve(projectRoot);
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const byKey = new Map<string, ExternalPackage>();

  for (const rel of roots) {
    const raws = await collectAtRoot(rel ? resolve(root, rel) : root, rel.replace(/\\/g, "/"));
    for (const raw of raws) {
      const key = `${raw.ecosystem} ${raw.name.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        // Prefer the strongest scope (prod beats dev/peer/optional).
        if (raw.scope === "prod") existing.scope = "prod";
        if (!existing.version && raw.version) existing.version = raw.version;
        continue;
      }
      const { category } = classify(raw.name);
      byKey.set(key, { ...raw, category });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => byOrdinal(a.ecosystem, b.ecosystem) || byOrdinal(a.name, b.name),
  );
}

/** Per ecosystem: import key → owning package name (see `PackageManagerSpec.installedOwners`). */
export type InstalledOwners = ReadonlyMap<PackageEcosystem, ReadonlyMap<string, string>>;

/**
 * What the package managers INSTALLED, read at the analyzed root and each
 * sub-project root (Composer's `vendor/composer/installed.json`): import key
 * → the package that owns it. A key found at an earlier root wins. Empty when
 * nothing is installed — usage then stays unknown, never falsely "unused".
 */
export async function collectInstalledOwners(
  projectRoot: string,
  subRoots: readonly string[],
): Promise<InstalledOwners> {
  const root = resolve(projectRoot);
  const roots = ["", ...subRoots].filter((r, i, a) => a.indexOf(r) === i);
  const out = new Map<PackageEcosystem, Map<string, string>>();
  for (const manager of PACKAGE_MANAGERS) {
    if (!manager.installedOwners) continue;
    const merged = out.get(manager.ecosystem) ?? new Map<string, string>();
    for (const rel of roots) {
      const abs = rel ? resolve(root, rel) : root;
      const owners = await manager.installedOwners.load((path) => readIf(join(abs, path)));
      for (const [key, pkg] of owners) if (!merged.has(key)) merged.set(key, pkg);
    }
    if (merged.size > 0) out.set(manager.ecosystem, merged);
  }
  return out;
}

// ─── Usage cross-check ───────────────────────────────────────────────────
// How an import names a package is the owning plugin's knowledge
// (`PackageManagerSpec.importKey` / `prefixMatch` / `assertsUnused`), and which
// ecosystems a language imports from is its manifest's `packageEcosystems`.

/**
 * Mark each package used/unused by cross-referencing declarations against the
 * imports in analyzed files. An ecosystem whose every import is visible
 * (`assertsUnused`: npm, Go, Cargo, pub) reports a declared package nothing
 * imports as unused; the rest are positive-only (a hit marks "used", a miss
 * stays unknown); an ecosystem whose imports name no package (Maven, Gradle,
 * Clojars) stays unknown.
 */
export function attachPackageUsage(
  packages: ExternalPackage[],
  analyses: readonly FileAnalysis[],
  opts?: { installedOwners?: InstalledOwners },
): void {
  const counts = new Map<PackageEcosystem, Map<string, number>>();
  const bump = (eco: PackageEcosystem, key: string) => {
    let b = counts.get(eco);
    if (!b) counts.set(eco, (b = new Map()));
    b.set(key, (b.get(key) ?? 0) + 1);
  };

  for (const fa of analyses) {
    const ecos = packageEcosystemsFor(fa.language);
    if (ecos.length === 0) continue;
    for (const imp of fa.imports) {
      const source = imp.source.trim();
      if (!source) continue;
      for (const eco of ecos) {
        const key = packageMatchingFor(eco)?.importKey?.(source);
        if (key) bump(eco, key);
      }
    }
  }

  // Sum the import counts in a bucket whose key satisfies a prefix/containment test.
  const matchCount = (bucket: Map<string, number> | undefined, test: (key: string) => boolean): number => {
    if (!bucket) return 0;
    let c = 0;
    for (const [k, n] of bucket) if (test(k)) c += n;
    return c;
  };

  // Installed owners: each imported key belongs to the package owning its
  // longest key (equal, or extended past the separator) — usage per package.
  const ownedUsage = new Map<PackageEcosystem, Map<string, number>>();
  for (const [eco, owners] of opts?.installedOwners ?? []) {
    const separator = packageMatchingFor(eco)?.installedOwners?.separator;
    if (separator === undefined || owners.size === 0) continue;
    const used = new Map<string, number>();
    for (const [key, n] of counts.get(eco) ?? []) {
      let owner: string | undefined;
      let bestLen = -1;
      for (const [prefix, pkgName] of owners) {
        if ((key === prefix || key.startsWith(prefix + separator)) && prefix.length > bestLen) {
          owner = pkgName;
          bestLen = prefix.length;
        }
      }
      if (owner) used.set(owner, (used.get(owner) ?? 0) + n);
    }
    ownedUsage.set(eco, used);
  }

  for (const pkg of packages) {
    const spec = packageMatchingFor(pkg.ecosystem);
    const bucket = counts.get(pkg.ecosystem);
    const name = pkg.name.toLowerCase();
    let count: number;
    if (spec?.installedOwners) {
      count = ownedUsage.get(pkg.ecosystem)?.get(name) ?? 0;
    } else if (spec?.prefixMatch) {
      const { separator, bidirectional } = spec.prefixMatch;
      count = matchCount(bucket, (k) =>
        k === name || k.startsWith(name + separator) || (bidirectional === true && name.startsWith(k + separator)));
    } else {
      count = bucket?.get(spec?.packageKey?.(pkg.name) ?? name) ?? 0;
    }

    if (count > 0) {
      pkg.used = true;
      pkg.usageCount = count;
    } else if (spec?.assertsUnused) {
      pkg.used = false;
      pkg.usageCount = 0;
    }
    // else: unknown (positive-only ecosystems / no reliable mapping).
  }
}

// ─── Framework derivation ──────────────────────────────────────────────────

/**
 * Derive framework detections from recognised packages. Confidence reflects how
 * the dependency is consumed: a prod/peer dependency that's also imported is a
 * "high" signal; a dev-only or declared-but-unused one is "medium".
 */
export function deriveFrameworksFromPackages(packages: readonly ExternalPackage[]): FrameworkDetection[] {
  const byId = new Map<string, FrameworkDetection>();
  for (const pkg of packages) {
    const known = classify(pkg.name);
    if (!known.framework) continue;
    const strong = (pkg.scope === "prod" || pkg.scope === "peer") && pkg.used !== false;
    const detection: FrameworkDetection = {
      id: known.framework.id,
      name: known.framework.name,
      confidence: strong ? "high" : "medium",
      detectedVia: `${pkg.ecosystem} dependency (${pkg.name})`,
    };
    const existing = byId.get(detection.id);
    // Keep the strongest confidence seen for this framework id.
    if (!existing || (existing.confidence !== "high" && detection.confidence === "high")) {
      byId.set(detection.id, detection);
    }
  }
  return [...byId.values()];
}

/**
 * Merge rule-based detections (from `framework-detector.ts`) with inventory-
 * derived ones. The rule-based entry wins on an id collision (its `detectedVia`
 * is more specific and keeps existing output stable); inventory-only frameworks
 * are appended. Order: rule-based first, then new ones alphabetically by name.
 */
export function mergeFrameworkDetections(
  ruleBased: readonly FrameworkDetection[],
  derived: readonly FrameworkDetection[],
): FrameworkDetection[] {
  const byId = new Map<string, FrameworkDetection>();
  for (const f of ruleBased) byId.set(f.id, f);
  const added: FrameworkDetection[] = [];
  for (const f of derived) {
    if (!byId.has(f.id)) {
      byId.set(f.id, f);
      added.push(f);
    }
  }
  added.sort((a, b) => byOrdinal(a.name, b.name));
  return [...ruleBased, ...added];
}
