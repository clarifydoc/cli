import type { FileAnalysis } from "../types/analysis.js";

/**
 * Requests a page makes through a URL in a markup attribute: an element
 * carrying `data-update-url="/clubs/1"` (`InteractiveElementInfo.request.attribute`,
 * materialized as an api-call with `urlAttribute`) whose script reads that
 * attribute and requests it (`FileAnalysis.attributeReads`). Such a request
 * stands only where a project script reads the attribute — a `data-*url`
 * nothing reads is no request — and takes the verb its readers (those of
 * the page's own sub-project, when it has any) agree on when the element names none (`data-method`). Returns the number
 * of requests kept and dropped.
 */
export function applyAttributeRequests(analyses: readonly FileAnalysis[]): { kept: number; dropped: number } {
  const readers = new Map<string, Set<string>>();
  for (const a of analyses) {
    for (const r of a.attributeReads ?? []) {
      for (const key of [`${a.projectId ?? ""}\0${r.attribute}`, `*\0${r.attribute}`]) (readers.get(key) ?? readers.set(key, new Set()).get(key)!).add(r.method ?? "");
    }
  }
  let kept = 0;
  let dropped = 0;
  /** The verb the readers agree on, "" when they name none or differ, null when nothing reads the attribute. */
  const verbOf = (a: FileAnalysis, attribute: string): string | null => {
    // The page's own sub-project's scripts first; a static bundle is often a package of its own.
    const methods = readers.get(`${a.projectId ?? ""}\0${attribute}`) ?? readers.get(`*\0${attribute}`);
    if (!methods) return null;
    const named = [...methods].filter(Boolean);
    return named.length === 1 ? named[0]! : "";
  };
  for (const a of analyses) {
    if (!a.interactiveElements.some((e) => e.request?.attribute)) continue;
    for (const el of a.interactiveElements) {
      const req = el.request;
      if (!req?.attribute) continue;
      const verb = verbOf(a, req.attribute);
      if (verb === null) {
        delete el.request;
        dropped++;
        continue;
      }
      if (!req.method && verb) req.method = verb;
      kept++;
    }
    // The one-line function materialized for a request that does not stand goes with it.
    const used = new Set(a.interactiveElements.filter((e) => e.request).map((e) => e.handler));
    const goneLines = new Set(a.dataSources.filter((d) => d.urlAttribute && verbOf(a, d.urlAttribute) === null).map((d) => d.line));
    a.functions = a.functions.filter((f) => !(goneLines.has(f.line) && f.endLine === f.line && f.calls.length === 0 && !used.has(f.name)));
    a.dataSources = a.dataSources.filter((d) => {
      if (!d.urlAttribute) return true;
      const verb = verbOf(a, d.urlAttribute);
      if (verb === null) return false;
      if (verb && d.name === d.target) d.name = `${verb} ${d.target}`;
      return true;
    });
  }
  return { kept, dropped };
}
