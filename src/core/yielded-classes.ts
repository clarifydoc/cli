import type { FileAnalysis } from "../types/analysis.js";

/**
 * A class a plugin synthesizes for what a code generator writes (`ClassInfo.yieldsTo` names the class it is generated
 * beside) stands only where the generated source is not in the analysis: a written class of the same name and
 * language in the same sub-project replaces it, so one name is never two classes. Project-level and in-memory.
 */
export function dropYieldedClasses(analyses: FileAnalysis[]): void {
  let any = false;
  for (const a of analyses) if (a.classes.some((c) => c.yieldsTo)) { any = true; break; }
  if (!any) return;
  const written = new Set<string>();
  const key = (a: FileAnalysis, name: string): string => `${a.projectId ?? ""}\0${a.language}\0${name}`;
  for (const a of analyses) for (const c of a.classes) if (!c.synthetic) written.add(key(a, c.name));
  for (const a of analyses) {
    if (!a.classes.some((c) => c.yieldsTo)) continue;
    a.classes = a.classes.filter((c) => {
      if (!c.yieldsTo) return true;
      // `yieldsTo` names the written sibling: the generated class itself, or the one it nests in (`ImmutableClub`).
      return !written.has(key(a, c.yieldsTo));
    });
  }
}
