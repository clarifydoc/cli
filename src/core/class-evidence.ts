import type { FileAnalysis } from "../types/analysis.js";

/**
 * Where classes are looked up by namespace (`classNamesByEvidence`): the full, lower-cased name a class `written` in
 * `analysis` means — as written when it starts with the separator, else through the import that binds its first
 * segment, else the file's own namespace (the class around `line` where a file opens several).
 */
export function evidenceFullName(analysis: FileAnalysis, sep: string, written: string, line = 0): string {
  let full: string;
  if (written.startsWith(sep)) full = written.slice(sep.length);
  else {
    const segments = written.split(sep);
    const bound = analysis.imports.find((i) => i.isType && i.specifiers.includes(segments[0]!));
    // A file opening several namespaces records each class's own: the caller's is the class around the call.
    const around = analysis.classes.some((c) => c.namespace) ? analysis.classes.find((c) => c.line <= line && line <= c.endLine) : undefined;
    const ns = around ? around.namespace : analysis.declaredNamespace;
    full = bound ? [bound.source, ...segments.slice(1)].join(sep) : ns ? `${ns}${sep}${written}` : written;
  }
  return full.toLowerCase();
}

/** True when `other` declares a class named `simple` (lower-cased) whose namespace spells `full` (from `evidenceFullName`). */
export function declaresEvidenceName(other: FileAnalysis | undefined, sep: string, simple: string, full: string): boolean {
  // The class's own namespace where the file states one per class; else the file's.
  const named = other?.classes.some((c) => c.namespace) ? other.classes.filter((c) => c.name.toLowerCase() === simple) : [];
  const spaces = named.length > 0 ? named.map((c) => c.namespace) : [other?.declaredNamespace];
  return spaces.some((ns) => (ns ? `${ns}${sep}${simple}` : simple).toLowerCase() === full);
}
