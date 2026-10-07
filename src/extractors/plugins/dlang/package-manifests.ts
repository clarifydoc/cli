import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared, jsonObject } from "../shared/declared-package.js";

/**
 * dub, in either recipe format. A dependency names a package, optionally one
 * of its sub-packages (`vibe-d:http` is `vibe-d`); a `:sub` reference is the
 * recipe's own sub-package, not a dependency. Dependencies of every
 * configuration and sub-package count.
 */

/** `dub.json`: `"dependencies": { "vibe-d": "~>0.9", "x": { "version": "1.0", "optional": true } }`. */
function parseDubJson(text: string, declaredIn: string): DeclaredPackage[] {
  const root = jsonObject(text);
  if (!root) return [];
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const deps = obj.dependencies;
    if (deps && typeof deps === "object") {
      for (const [ref, spec] of Object.entries(deps as Record<string, unknown>)) {
        const version = typeof spec === "string" ? spec : typeof (spec as { version?: unknown })?.version === "string" ? (spec as { version: string }).version : null;
        const optional = typeof spec === "object" && (spec as { optional?: unknown })?.optional === true;
        add(ref, version, optional);
      }
    }
    for (const key of ["configurations", "subPackages"]) {
      const list = obj[key];
      if (Array.isArray(list)) for (const item of list) collect(item);
    }
  };
  const add = (ref: string, version: string | null, optional: boolean): void => {
    if (ref.startsWith(":")) return;
    const name = ref.split(":")[0]!;
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    out.push(declared(name, version, "dub", optional ? "optional" : "prod", declaredIn));
  };
  collect(root);
  return out;
}

/** `dub.sdl`: `dependency "vibe-d" version="~>0.9"` (also inside `configuration` / `subPackage` blocks). */
function parseDubSdl(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\s*dependency\s+"([^"]+)"([^\n]*)/gm)) {
    const ref = m[1]!;
    if (ref.startsWith(":")) continue;
    const name = ref.split(":")[0]!;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const version = /\bversion\s*=\s*"([^"]*)"/.exec(m[2]!)?.[1] ?? null;
    const optional = /\boptional\s*=\s*true\b/.test(m[2]!);
    out.push(declared(name, version, "dub", optional ? "optional" : "prod", declaredIn));
  }
  return out;
}

export const dubPackageManager: PackageManagerSpec = {
  ecosystem: "dub",
  manifests: [
    { files: ["dub.json"], parse: (text, file) => parseDubJson(text, file.declaredIn) },
    { files: ["dub.sdl"], parse: (text, file) => parseDubSdl(text, file.declaredIn) },
  ],
  // `import vibe.http.router` → `vibe`; the language's own `std` / `core` /
  // `etc` modules name no package. A package's modules usually start with its
  // name less a `-d` / `-native` suffix (`vibe-d` → `vibe`, `mysql-native` →
  // `mysql`); the rest only miss (usage is positive-only).
  importKey(source) {
    const first = source.split(".")[0]!;
    return /^(?:std|core|etc|object)$/.test(first) ? null : first.toLowerCase();
  },
  packageKey: (name) => name.toLowerCase().replace(/-(?:d|dlang|native)$/, ""),
};
