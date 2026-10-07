import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import type { PackageScope } from "../../../types/analysis.js";
import { declared, jsonObject } from "../shared/declared-package.js";

/** `Cro::HTTP:ver<0.8.9>:auth<zef:cro>` → name + version. */
function spec(entry: unknown): { name: string; version: string | null } | null {
  if (typeof entry !== "string") return null;
  const name = /^((?:[\w-]+)(?:::[\w-]+)*)/.exec(entry)?.[1];
  return name ? { name, version: /:ver<([^>]+)>/.exec(entry)?.[1] ?? null } : null;
}

/**
 * `META6.json`: `depends` (prod), `test-depends` / `build-depends` (dev) as
 * lists, or the newer `depends: { runtime: { requires: […] }, test: … }`.
 */
function parseMeta6(text: string, declaredIn: string): DeclaredPackage[] {
  const meta = jsonObject(text);
  if (!meta) return [];
  const out: DeclaredPackage[] = [];
  const add = (list: unknown, scope: PackageScope) => {
    for (const e of Array.isArray(list) ? list : []) {
      const s = spec(e);
      if (s) out.push(declared(s.name, s.version, "raku", scope, declaredIn));
    }
  };
  const depends = meta.depends;
  if (Array.isArray(depends)) add(depends, "prod");
  else if (depends && typeof depends === "object") {
    for (const [phase, v] of Object.entries(depends as Record<string, { requires?: unknown }>)) add(v?.requires, phase === "runtime" ? "prod" : "dev");
  }
  add(meta["test-depends"], "dev");
  add(meta["build-depends"], "dev");
  return out;
}

export const rakuPackageManager: PackageManagerSpec = {
  ecosystem: "raku",
  manifests: [{ files: ["META6.json"], parse: (text, file) => parseMeta6(text, file.declaredIn) }],
  // `use Cro::HTTP::Router` loads a module of the `Cro::HTTP` distribution.
  importKey: (s) => s.toLowerCase(),
  prefixMatch: { separator: "::", bidirectional: true },
};
