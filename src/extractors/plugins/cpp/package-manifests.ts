import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";

/** vcpkg: `vcpkg.json` dependencies (bare names or `{ name, "version>=" }`). */
function parseVcpkg(text: string, declaredIn: string): DeclaredPackage[] {
  const json = jsonObject(text);
  if (!json) return [];
  const out: DeclaredPackage[] = [];
  const deps = json.dependencies;
  if (Array.isArray(deps)) {
    for (const d of deps) {
      if (typeof d === "string") out.push(declared(d, null, "vcpkg", "prod", declaredIn));
      else if (d && typeof d === "object" && typeof (d as Record<string, unknown>).name === "string") {
        const o = d as Record<string, unknown>;
        out.push(declared(o.name as string, (typeof o["version>="] === "string" ? o["version>="] as string : null), "vcpkg", "prod", declaredIn));
      }
    }
  }
  return out;
}

/** Conan: `conanfile.txt` [requires] / [tool_requires] / [build_requires] `name/version`. */
function parseConan(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let scope: PackageScope | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const s = sec[1]!.toLowerCase();
      scope = s === "requires" ? "prod" : (s === "tool_requires" || s === "build_requires") ? "dev" : null;
      continue;
    }
    if (!scope || !line) continue;
    const m = line.match(/^([A-Za-z0-9_.+-]+)\/([^@\s]+)/); // name/version (fmt/9.1.0)
    if (m) out.push(declared(m[1]!, m[2]!, "conan", scope, declaredIn));
  }
  return out;
}

/**
 * `#include <fmt/format.h>` → `fmt`: the first path segment ≈ the package.
 * Standard headers (no slash) match no package; usage is positive-only.
 */
const includeKey = (s: string): string => s.split("/")[0]!.toLowerCase().replace(/\.(h|hpp|hxx|hh)$/, "");

export const vcpkgPackageManager: PackageManagerSpec = {
  ecosystem: "vcpkg",
  manifests: [{ files: ["vcpkg.json"], parse: (text, file) => parseVcpkg(text, file.declaredIn) }],
  importKey: includeKey,
};

export const conanPackageManager: PackageManagerSpec = {
  ecosystem: "conan",
  manifests: [{ files: ["conanfile.txt"], parse: (text, file) => parseConan(text, file.declaredIn) }],
  importKey: includeKey,
};
