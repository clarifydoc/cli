import type { DeclaredPackage } from "../../../types/language-plugin.js";

/**
 * Readers for the lockfiles that sit beside a manifest: the versions the
 * package manager actually INSTALLED, keyed by package name (lowercased). A
 * manifest declares a range (`^4.17.0`); a vulnerability database needs the
 * exact version, and taking a range's lower bound is a guess that reports
 * advisories the install does not have.
 */

/** Record each package's installed version from `locked` (name → version), as `resolvedVersion`. */
export function withLocked(pkgs: DeclaredPackage[], locked: ReadonlyMap<string, string> | null): DeclaredPackage[] {
  if (!locked || locked.size === 0) return pkgs;
  for (const p of pkgs) {
    const v = locked.get(p.name.toLowerCase());
    if (v) p.resolvedVersion = v;
  }
  return pkgs;
}

/** `[[package]] name = "x" version = "y"` blocks: Cargo.lock, poetry.lock, uv.lock. */
export function parseTomlPackageLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    // A name locked at two versions: no one installed version to report.
    if (name && version) {
      const key = name.toLowerCase();
      if (out.has(key) && out.get(key) !== version) out.set(key, "");
      else out.set(key, version);
    }
  }
  for (const [k, v] of out) if (!v) out.delete(k);
  return out;
}

/** npm `package-lock.json` (lockfile v1, v2, v3): the top-level installs only. */
export function parsePackageLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  const lock = json as { packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
  if (lock.packages) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      // `node_modules/a`, not `node_modules/a/node_modules/b` (a nested copy).
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(path);
      if (m && typeof entry?.version === "string") out.set(m[1]!.toLowerCase(), entry.version);
    }
  } else if (lock.dependencies) {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (typeof entry?.version === "string") out.set(name.toLowerCase(), entry.version);
    }
  }
  return out;
}

/** Yarn classic `yarn.lock`: `"name@range", name@range2:` then `  version "x"`. */
export function parseYarnLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith(" ") && !line.startsWith("#") && line.endsWith(":")) {
      names = line.slice(0, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, ""))
        .map((spec) => spec.slice(0, spec.lastIndexOf("@") > 0 ? spec.lastIndexOf("@") : spec.length).toLowerCase());
      continue;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (v && names.length) {
      for (const n of names) if (!out.has(n)) out.set(n, v[1]!);
      names = [];
    }
  }
  return out;
}

/** Composer `composer.lock`: `packages` and `packages-dev`, versions without the `v`. */
export function parseComposerLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: { packages?: Array<{ name?: string; version?: string }>; "packages-dev"?: Array<{ name?: string; version?: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  for (const p of [...(json.packages ?? []), ...(json["packages-dev"] ?? [])]) {
    if (typeof p.name === "string" && typeof p.version === "string") out.set(p.name.toLowerCase(), p.version.replace(/^v(?=\d)/, ""));
  }
  return out;
}

/** Pipenv `Pipfile.lock`: `default` and `develop`, `"==x"` versions. */
export function parsePipfileLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: { default?: Record<string, { version?: string }>; develop?: Record<string, { version?: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  for (const group of [json.default, json.develop]) {
    for (const [name, entry] of Object.entries(group ?? {})) {
      const v = /^==\s*(.+)$/.exec(entry?.version ?? "")?.[1];
      if (v) out.set(name.toLowerCase(), v);
    }
  }
  return out;
}

/**
 * pnpm `pnpm-lock.yaml`: the root importer's direct dependencies — lockfile
 * v6/v9 (`importers: .: dependencies: name: { specifier, version }`) and v5
 * (top-level `dependencies: name: version`). A version's peer suffix
 * (`1.2.3(react@18.2.0)`) is dropped.
 */
export function parsePnpmLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let inRoot = false;
  let inDeps = false;
  let current: string | null = null;
  const importers = /^importers:\s*$/m.test(text);
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (importers) {
      if (indent === 0) { inRoot = false; inDeps = false; continue; }
      if (indent === 2) { inRoot = t === ".:" || t === "'.':"; inDeps = false; continue; }
      if (!inRoot) continue;
      if (indent === 4) { inDeps = /^(?:dependencies|devDependencies|optionalDependencies):$/.test(t); continue; }
      if (!inDeps) continue;
      if (indent === 6) { current = t.replace(/:$/, "").replace(/^['"]|['"]$/g, ""); continue; }
      const v = /^version:\s*['"]?([^'"(\s]+)/.exec(t);
      if (indent === 8 && v && current) out.set(current.toLowerCase(), v[1]!);
    } else {
      if (indent === 0) { inDeps = /^(?:dependencies|devDependencies|optionalDependencies):$/.test(t); continue; }
      const m = /^['"]?([^'":]+)['"]?:\s*['"]?([^'"(\s]+)/.exec(t);
      // v5 joins the peer suffix with `_` (`1.0.0_vite@5.0.0`).
      if (inDeps && indent === 2 && m) out.set(m[1]!.toLowerCase(), m[2]!.split("_")[0]!);
    }
  }
  return out;
}
