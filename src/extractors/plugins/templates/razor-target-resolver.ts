import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Razor tag helpers name their target, not a path: `asp-controller="Account"
 * asp-action="Login"` is `AccountController.Login`, and `asp-page="/Account/Login"
 * asp-page-handler="Delete"` is `OnPostDelete` (or `OnPostDeleteAsync`) of the
 * page model in `Pages/Account/Login.cshtml.cs`. The verb picks the overload:
 * a POST form reaches the action marked `[HttpPost]` when the controller has
 * both. Links go from the view's handler symbol to that method.
 */
export class RazorTargetResolver implements DispatchResolver {
  readonly id = "razor-target";
  readonly languages: Language[] = ["razor", "csharp"];
  readonly priority = 42;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = analyses.filter((a) => a.language === "razor" && a.interactiveElements.some((e) => e.request && !e.request.target.startsWith("/")));
    if (views.length === 0) return [];
    const cs = analyses.filter((a) => a.language === "csharp");
    const links: SymbolLink[] = [];
    const push = (view: FileAnalysis, handler: string, line: number, file: string, symbol: string, targetLine: number): void => {
      links.push({ sourceFile: view.filePath, sourceSymbol: handler, sourceLine: line, callName: handler, targetFile: file, targetSymbol: symbol, targetLine, confidence: "INFERRED" });
    };
    for (const view of views) {
      for (const el of view.interactiveElements) {
        if (!el.request || !el.handler || el.request.target.startsWith("/")) continue;
        const { method, target } = el.request;
        if (target.startsWith("page:")) {
          const [pagePath, pageHandler] = target.slice(5).split("#");
          const page = pagePath === "." ? view.filePath.replace(/\.cshtml$/, "") : pagePath!.replace(/^\//, "");
          const wanted = [`On${method === "GET" ? "Get" : "Post"}${pageHandler ?? ""}`];
          wanted.push(`${wanted[0]}Async`);
          for (const a of cs) {
            if (!a.filePath.endsWith(`${page}.cshtml.cs`) && !(pagePath !== "." && a.filePath.endsWith(`Pages/${page}.cshtml.cs`))) continue;
            for (const cls of a.classes) for (const m of cls.methods) if (wanted.includes(m.name)) push(view, el.handler, el.line, a.filePath, `${cls.name}.${m.name}`, m.line);
          }
          continue;
        }
        const [ctl, action] = target.split("#");
        if (!ctl || !action) continue;
        const candidates: Array<{ file: string; symbol: string; line: number; post: boolean }> = [];
        for (const a of cs) {
          for (const cls of a.classes) {
            if (cls.name !== `${ctl}Controller` && cls.name !== ctl) continue;
            for (const m of cls.methods) {
              if (m.name !== action && m.name !== `${action}Async`) continue;
              candidates.push({ file: a.filePath, symbol: `${cls.name}.${m.name}`, line: m.line, post: m.decorators.some((d) => /^Http(?:Post|Put|Delete|Patch)\b/.test(d)) });
            }
          }
        }
        const isPost = method !== "GET";
        const byVerb = candidates.filter((c) => c.post === isPost);
        for (const c of byVerb.length > 0 ? byVerb : candidates) push(view, el.handler, el.line, c.file, c.symbol, c.line);
      }
    }
    return links;
  }
}
