import type { FileAnalysis, Language, SymbolLink } from "../../../../types/analysis.js";
import type { DispatchResolver } from "../../../dispatch/base.js";

/**
 * A Django template's form, link or htmx request to `{% url 'clubs:detail' %}`
 * (read as `route:clubs:detail`) reaches the route of that name: the link goes
 * from the element's handler to the route's symbol, which the symbol linker
 * already anchors on its view, so a click traces into the view and on to the
 * models it touches. A form or a write request joins the name's write route, a
 * link its GET one; a name served by one row joins it whatever the verb (a
 * class-based view answers both). Names are looked up in the template's own
 * sub-project.
 */
export class DjangoTemplateUrlResolver implements DispatchResolver {
  readonly id = "django-template-url";
  readonly languages: Language[] = ["python", "html"];
  readonly priority = 58;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const templates = analyses.filter((a) => a.language === "html" && a.interactiveElements.some((e) => e.request?.target.startsWith("route:")));
    if (templates.length === 0) return [];
    const byName = new Map<string, Array<{ file: string; projectId: string | undefined; method: string | null; path: string; line: number }>>();
    for (const a of analyses) {
      if (a.language !== "python") continue;
      for (const r of a.routes) {
        if (!r.name || r.kind !== "api") continue;
        (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)!).push({ file: a.filePath, projectId: a.projectId, method: r.httpMethod, path: r.path, line: r.line });
      }
    }
    if (byName.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const t of templates) {
      for (const el of t.interactiveElements) {
        const target = el.request?.target;
        if (!target?.startsWith("route:") || !el.handler) continue;
        const rows = (byName.get(target.slice(6)) ?? []).filter((r) => r.projectId === t.projectId);
        const verb = el.request!.method;
        const matching = rows.filter((r) => r.method === verb || r.method === null);
        for (const r of matching.length > 0 ? matching : rows) {
          const symbol = `route:${r.method ?? "USE"} ${r.path}`;
          const key = `${t.filePath}\0${el.handler}\0${r.file}\0${symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ sourceFile: t.filePath, sourceSymbol: el.handler, sourceLine: el.line, callName: el.handler, targetFile: r.file, targetSymbol: symbol, targetLine: r.line, confidence: "INFERRED" });
        }
      }
    }
    return links;
  }
}
