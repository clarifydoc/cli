import type { PackageScope } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";

/**
 * A package's `DESCRIPTION`: `Depends` / `Imports` / `LinkingTo` (prod) and
 * `Suggests` (dev), each a comma list that may run over indented lines —
 * `Imports: DBI (>= 1.1.0), dplyr`. R itself is no package.
 */
function parseDescription(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w@/.-]*):\s*(.*)$/.exec(line);
    if (field) { current = field[1]!; fields.set(current, field[2]!); continue; }
    if (current && /^\s+\S/.test(line)) fields.set(current, fields.get(current)! + " " + line.trim());
  }
  const scopes: Array<[string, PackageScope]> = [["Depends", "prod"], ["Imports", "prod"], ["LinkingTo", "prod"], ["Suggests", "dev"]];
  for (const [field, scope] of scopes) {
    for (const entry of (fields.get(field) ?? "").split(",")) {
      const m = /^\s*([A-Za-z][\w.]*)\s*(?:\(([^)]*)\))?/.exec(entry);
      if (m && m[1] !== "R") out.push(declared(m[1]!, m[2]?.trim() ?? null, "cran", scope, declaredIn));
    }
  }
  return out;
}

/** `renv.lock`: every locked package with its version. */
function parseRenvLock(text: string, declaredIn: string): DeclaredPackage[] {
  const packages = jsonObject(text)?.Packages as Record<string, { Version?: string }> | undefined;
  if (!packages || typeof packages !== "object") return [];
  return Object.entries(packages).map(([name, p]) => declared(name, typeof p?.Version === "string" ? p.Version : null, "cran", "prod", declaredIn));
}

export const cranPackageManager: PackageManagerSpec = {
  ecosystem: "cran",
  manifests: [
    { files: ["DESCRIPTION"], parse: (text, file) => parseDescription(text, file.declaredIn) },
    { files: ["renv.lock"], parse: (text, file) => parseRenvLock(text, file.declaredIn) },
  ],
  // `library(dplyr)` / `require("DBI")`: the package name (a path is a file).
  importKey: (s) => (/^[A-Za-z][\w.]*$/.test(s) && !/\.[rR]$/.test(s) ? s.toLowerCase() : null),
};
