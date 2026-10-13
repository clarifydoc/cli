import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";
import { parsePackageLock, parsePnpmLock, parseYarnLock, withLocked } from "../shared/lockfiles.js";

/** npm: `package.json`'s dependency sections. */
function parseNpm(text: string, declaredIn: string): DeclaredPackage[] {
  const json = jsonObject(text);
  if (!json) return [];
  const out: DeclaredPackage[] = [];
  const sections: Array<[string, PackageScope]> = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];
  for (const [key, scope] of sections) {
    const deps = json[key] as Record<string, string> | undefined;
    if (!deps || typeof deps !== "object") continue;
    for (const [name, version] of Object.entries(deps)) {
      out.push(declared(name, typeof version === "string" ? version : null, "npm", scope, declaredIn));
    }
  }
  return out;
}

export const npmPackageManager: PackageManagerSpec = {
  ecosystem: "npm",
  manifests: [{
    files: ["package.json"],
    async parse(text, file) {
      const pkgs = parseNpm(text, file.declaredIn);
      const npmLock = await file.readSibling("package-lock.json");
      if (npmLock) return withLocked(pkgs, parsePackageLock(npmLock));
      const yarn = await file.readSibling("yarn.lock");
      if (yarn) return withLocked(pkgs, parseYarnLock(yarn));
      const pnpm = await file.readSibling("pnpm-lock.yaml");
      return pnpm ? withLocked(pkgs, parsePnpmLock(pnpm)) : pkgs;
    },
    selfName: (text) => { const name = jsonObject(text)?.name; return typeof name === "string" && name ? name : null; },
  }],
  // `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`; relative paths
  // and the `@/` / `~` aliases name project files.
  importKey(s) {
    if (s.startsWith(".") || s.startsWith("/") || s.startsWith("@/") || s.startsWith("~")) return null;
    if (s.startsWith("@")) {
      const parts = s.split("/");
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
    }
    return s.split("/")[0]!.toLowerCase();
  },
  assertsUnused: true,
};
