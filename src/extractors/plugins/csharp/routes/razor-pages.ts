import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { buildPath } from "./aspnet.js";

/**
 * Razor Pages: `Pages/Club.cshtml` declares `@page "/clubs/{id:int}"` and its code-behind
 * `Club.cshtml.cs` holds a `PageModel` whose `OnGet` / `OnPost` / `OnPostSave` (+ `Async`)
 * answer the verb. The template and the handlers live in two files, so the PageModel's
 * handlers are a `cs:page-model` fact and the resolver pairs it with the page's screen,
 * which carries the route path.
 */
export const CS_PAGE_MODEL = "cs:page-model";
export const PAGE_MODEL_GATE = /\bPageModel\b/;

export interface CsPageHandler {
  verb: string;
  method: string;
  /** `OnPostSave` → `Save` (`?handler=Save`); null for the page's default handler. */
  named: string | null;
  line: number;
}
export interface CsPageModelFact {
  handlers: CsPageHandler[];
}

const HANDLER = /^On(Get|Post|Put|Patch|Delete|Head|Options)([A-Z]\w*?)?$/;

export function extractPageModels(root: Node, facts: RouteFact[]): void {
  for (const cls of root.descendantsOfType("class_declaration")) {
    const base = cls.children.find((c) => c.type === "base_list")?.namedChildren.find((c) => c.type !== "comment");
    if (!base || !/^(?:[\w.]+\.)?PageModel$/.test(base.text.trim())) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    const handlers: CsPageHandler[] = [];
    for (const m of cls.childForFieldName("body")?.namedChildren ?? []) {
      if (m.type !== "method_declaration") continue;
      const method = m.childForFieldName("name")?.text ?? "";
      const h = HANDLER.exec(method.replace(/Async$/, ""));
      if (!h || !m.children.some((c) => c.type === "modifier" && c.text === "public")) continue;
      handlers.push({ verb: h[1]!.toUpperCase(), method, named: h[2] ?? null, line: m.startPosition.row + 1 });
    }
    if (handlers.length > 0) facts.push({ kind: CS_PAGE_MODEL, line: cls.startPosition.row + 1, owner: name, data: { handlers } satisfies CsPageModelFact });
  }
}

/** Pair each PageModel with the `.cshtml` beside its `.cshtml.cs`: one route per verb on the default handler and one per named handler at `?handler=Name`. */
export const razorPageRoutes: RouteResolver = {
  id: "razor-page-routes",
  languages: ["csharp", "razor"],
  priority: 26,
  resolve(analyses: FileAnalysis[]): void {
    const pages = new Map<string, string>();
    for (const a of analyses) {
      const route = a.screens?.[0]?.routePath;
      if (a.language === "razor" && route) pages.set(a.filePath, route);
    }
    if (pages.size === 0) return;
    for (const a of analyses) {
      if (a.language !== "csharp" || !a.filePath.endsWith(".cshtml.cs")) continue;
      const template = pages.get(a.filePath.slice(0, -3));
      if (!template) continue;
      const path = buildPath(null, template, null, null);
      const rows: RouteInfo[] = [];
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== CS_PAGE_MODEL) continue;
        // The default handler answers the page's own path; each named one (`OnPostDelete`) is `?handler=Delete`.
        const seen = new Set<string>();
        for (const h of (f.data as CsPageModelFact).handlers) {
          const key = `${h.verb} ${h.named ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ path: h.named === null ? path : `${path}?handler=${h.named}`, httpMethod: h.verb, kind: "api", handler: h.method, calls: [], middleware: [], line: h.line, ...(f.owner ? { owner: f.owner } : {}) });
        }
      }
      if (rows.length > 0) a.routes = [...a.routes, ...rows];
    }
  },
};
