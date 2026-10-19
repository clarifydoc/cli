import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";
import { composerLockLicenses, withLicenses, parseComposerLock, withLocked } from "../shared/lockfiles.js";

/** Composer: `composer.json` require / require-dev. */
function parseComposer(text: string, declaredIn: string): DeclaredPackage[] {
  const json = jsonObject(text);
  if (!json) return [];
  const out: DeclaredPackage[] = [];
  for (const [key, scope] of [["require", "prod"], ["require-dev", "dev"]] as Array<[string, PackageScope]>) {
    const deps = json[key] as Record<string, string> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      // Skip platform requirements (php itself, ext-*, lib-*) — not packages.
      if (name === "php" || /^(ext|lib)-/.test(name)) continue;
      out.push(declared(name, typeof version === "string" ? version : null, "composer", scope, declaredIn));
    }
  }
  return out;
}

/**
 * PHP namespace → package, from Composer's installed-package metadata
 * (`vendor/composer/installed.json` lists every installed package's PSR-4 /
 * PSR-0 autoload namespaces in one file). This is what makes Composer usage
 * reliable: a `use Vendor\Ns\Class` import belongs to the package whose
 * namespace is its longest prefix. Empty when vendor/ isn't present (usage
 * then stays unknown — never falsely "unused"). Keys are lowercased with the
 * trailing `\` trimmed; values are lowercased package names.
 */
async function loadComposerAutoload(readAtRoot: (rel: string) => Promise<string | null>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const raw = await readAtRoot("vendor/composer/installed.json");
  if (!raw) return map;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return map; }
  // Composer 2 wraps the list in `{ packages: [...] }`; Composer 1 is a bare array.
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)
        ? (parsed as { packages: unknown[] }).packages
        : []);
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.toLowerCase() : null;
    if (!name) continue;
    const autoload = e.autoload as Record<string, unknown> | undefined;
    if (!autoload) continue;
    for (const key of ["psr-4", "psr-0"]) {
      const block = autoload[key] as Record<string, unknown> | undefined;
      if (!block || typeof block !== "object") continue;
      for (const ns of Object.keys(block)) {
        const norm = ns.replace(/\\+$/, "").toLowerCase();
        if (norm && !map.has(norm)) map.set(norm, name);
      }
    }
  }
  return map;
}

export const composerPackageManager: PackageManagerSpec = {
  ecosystem: "composer",
  manifests: [{
    files: ["composer.json"],
    async parse(text, file) {
      const lock = await file.readSibling("composer.lock");
      return withLicenses(withLocked(parseComposer(text, file.declaredIn), lock ? parseComposerLock(lock) : null), lock ? composerLockLicenses(lock) : null);
    },
  }],
  // The full namespace (`Illuminate\Support\Facades\Route`) — resolved to its
  // package through the installed autoload map.
  importKey: (s) => (s.startsWith(".") ? null : s.toLowerCase()),
  installedOwners: { separator: "\\", load: loadComposerAutoload },
};
