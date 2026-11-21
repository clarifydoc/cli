import type { ImportInfo } from "../../../types/analysis.js";
import type { DeclaredPackage, PackageManagerSpec } from "../../../types/language-plugin.js";
import { declared } from "../shared/declared-package.js";

/** Go modules: `go.mod` `require` lines and blocks; a `// indirect` one is `transitive`. */
function parseGoMod(text: string, declaredIn: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  // require ( <path> <version> [// indirect] ) blocks and single-line requires.
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("require (")) { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    let body = line;
    if (!inBlock) {
      const single = line.match(/^require\s+(.+)$/);
      if (!single) continue;
      body = single[1]!;
    }
    if (!body || body.startsWith("//")) continue;
    const parts = body.replace(/\/\/.*$/, "").trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pkg = declared(parts[0]!, parts[1]!, "go", "prod", declaredIn);
    // Required for a dependency's sake, not imported by this module.
    if (/\/\/\s*indirect\b/.test(body)) pkg.transitive = true;
    out.push(pkg);
  }
  return out;
}

/** go.mod `replace` directives whose target is a directory (`=> ./kit`, `=> ../shared`), single-line and block. */
export function goLocalReplacements(text: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^replace\s*\($/.test(line)) { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    const body = inBlock ? line : /^replace\s+(.+)$/.exec(line)?.[1];
    if (!body) continue;
    const m = /^(\S+)(?:\s+\S+)?\s*=>\s*(\.{1,2}\/\S*|\.{1,2})\s*$/.exec(body);
    if (m) out.push({ name: m[1]!, path: m[2]! });
  }
  return out;
}

/** The parts of an OSV `affected[]` entry Go's records state: `ecosystem_specific.imports[]`. */
interface OsvGoAffected {
  package?: { name?: string; ecosystem?: string };
  ecosystem_specific?: { imports?: Array<{ path?: string; symbols?: string[] }> };
}

/**
 * The vulnerable functions of a Go advisory: `ecosystem_specific.imports[]` (an import path and its symbols) of the
 * entry naming THIS module. Only exported names are kept (`Unmarshal`, `Decoder.Decode`): an unexported symbol is
 * reached through one of them, and no caller writes it.
 */
function goAdvisoryFunctions(affected: readonly unknown[], name: string): Array<{ path: string; symbols: string[] }> {
  const byPath = new Map<string, Set<string>>();
  for (const a of affected as OsvGoAffected[]) {
    if (a?.package?.ecosystem !== "Go" || a.package.name !== name) continue;
    for (const imp of a.ecosystem_specific?.imports ?? []) {
      if (typeof imp.path !== "string" || !Array.isArray(imp.symbols)) continue;
      const exported = imp.symbols.filter((s): s is string => typeof s === "string" && /^\p{Lu}/u.test(s));
      if (exported.length === 0) continue;
      const set = byPath.get(imp.path) ?? byPath.set(imp.path, new Set()).get(imp.path)!;
      for (const s of exported) set.add(s);
    }
  }
  return [...byPath].map(([path, set]) => ({ path, symbols: [...set].sort() }));
}

/**
 * The names a Go call through an import is written with: the specifiers the import reads (the package name, or its
 * alias). A dot import, or a name Go takes from a path segment that is no plain identifier (`yaml.v3`, a `/v2`
 * suffix, `go-yaml`), cannot be matched to a call head.
 */
function goCallHeads(imp: ImportInfo): { heads: string[]; unreadable: boolean } {
  const specifiers = imp.specifiers ?? [];
  return {
    heads: specifiers.filter((n) => n !== "_" && n !== "."),
    unreadable: !!imp.inScope || specifiers.some((n) => (n !== "_" && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(n)) || /^v\d+$/.test(n)),
  };
}

export const goPackageManager: PackageManagerSpec = {
  ecosystem: "go",
  manifests: [{
    files: ["go.mod"],
    parse: (text, file) => parseGoMod(text, file.declaredIn),
    selfName: (text) => /^module\s+(\S+)/m.exec(text)?.[1] ?? null,
    localPackages: goLocalReplacements,
  }, {
    // A workspace's `replace` maps a module path to a directory as go.mod's does. Its `use`
    // lines name modules that carry their own go.mod, which each is a sub-project for.
    files: ["go.work"],
    parse: () => [],
    localPackages: goLocalReplacements,
  }],
  // The full import path: the module path is it, or an ancestor of it.
  importKey: (s) => (s.startsWith(".") ? null : s.toLowerCase()),
  prefixMatch: { separator: "/" },
  assertsUnused: true,
  advisoryFunctions: { functionsOf: goAdvisoryFunctions, callHeads: goCallHeads },
};
