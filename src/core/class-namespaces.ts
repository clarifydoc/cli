import type { ClassInfo, FileAnalysis } from "../types/analysis.js";

/**
 * Out-of-line definitions written through a namespace their file never opens
 * (`void Away::Club::play() {` in a source file that only includes the header
 * declaring `namespace Away { class Club … }`). The file alone cannot tell a
 * namespace from an enclosing class there, so its plugin names the part
 * `Away::Club`; once every file is read, a part no class of that path is
 * declared for, whose leading names are the namespace of exactly one declared
 * class of the remaining name, becomes that class's part: `Club` of namespace
 * `Away`. A class nested in a class (`Outer::Inner`) is declared under its path
 * and keeps it. Idempotent; mutates the analyses in memory.
 */
export function placeNamespacedParts(analyses: readonly FileAnalysis[]): number {
  // Declared classes by language + name → the namespaces declaring one ("" for none).
  const declared = new Map<string, Set<string>>();
  let namespaced = false;
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (cls.namespace) namespaced = true;
      if (cls.extension) continue;
      const key = `${a.language}\0${cls.name}`;
      (declared.get(key) ?? declared.set(key, new Set()).get(key)!).add(cls.namespace ?? "");
    }
  }
  if (!namespaced) return 0;
  let moved = 0;
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (!cls.extension || !cls.name.includes("::") || declared.has(`${a.language}\0${cls.name}`)) continue;
      const place = namespacePlacement(cls, (name) => declared.get(`${a.language}\0${name}`));
      if (!place) continue;
      cls.name = place.name;
      cls.namespace = place.namespace;
      moved++;
    }
  }
  return moved;
}

function namespacePlacement(
  cls: ClassInfo,
  namespacesOf: (name: string) => ReadonlySet<string> | undefined,
): { name: string; namespace: string } | null {
  const segments = cls.name.split("::");
  // The shortest qualifier first: `A::B::Club` is `Club` of `A::B` before it is `B::Club` of `A`.
  for (let k = segments.length - 1; k >= 1; k--) {
    const name = segments.slice(k).join("::");
    const written = segments.slice(0, k).join("::");
    const spaces = namespacesOf(name);
    if (!spaces) continue;
    // Written inside a namespace of its own (`namespace League { void Away::Club::play() {} }`) the path is
    // relative to it; else it names the namespace from the top.
    const candidates = [cls.namespace ? `${cls.namespace}::${written}` : null, written].filter((n): n is string => !!n);
    const hit = candidates.find((n) => spaces.has(n));
    if (hit) return { name, namespace: hit };
  }
  return null;
}
