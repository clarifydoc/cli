import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { phpViewKey } from "./views.js";

/**
 * A controller method renders a view by name — `$this->load->view('clubs/edit', $data)`,
 * CI4 `return view('clubs/edit')` — and a view composes others the same way
 * (`$this->load->view('embeds/header')`). Each keyed call (`ci-view:<name>`,
 * see call-hooks.ts) links its caller to the view's top-level code under
 * `views/` in the same sub-project, so a route reaches the page it serves and
 * the page reaches its pieces. A name no view file answers is left unlinked.
 */
export class CodeIgniterViewResolver implements DispatchResolver {
  readonly id = "codeigniter-view";
  readonly languages: Language[] = ["php"];
  readonly priority = 56;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const views = new Map<string, FileAnalysis>();
    for (const a of analyses) {
      const key = phpViewKey(a.filePath);
      if (key !== null && a.functions.some((f) => f.name === "<setup>")) views.set(`${a.projectId ?? ""}\0${key.toLowerCase()}`, a);
    }
    if (views.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const scan = (a: FileAnalysis, symbol: string, calls: FileAnalysis["functions"][number]["calls"]): void => {
      for (const c of calls) {
        if (!c.key?.startsWith("ci-view:")) continue;
        const view = views.get(`${a.projectId ?? ""}\0${c.key.slice(8).toLowerCase()}`);
        if (!view || view === a) continue;
        const id = `${a.filePath}\0${symbol}\0${view.filePath}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const setup = view.functions.find((f) => f.name === "<setup>")!;
        links.push({ sourceFile: a.filePath, sourceSymbol: symbol, sourceLine: c.line, callName: c.name, targetFile: view.filePath, targetSymbol: setup.name, targetLine: setup.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
      }
    };
    for (const a of analyses) {
      for (const f of a.functions) scan(a, f.name, f.calls);
      for (const cls of a.classes) for (const m of cls.methods) scan(a, `${cls.name}.${m.name}`, m.calls);
    }
    return links;
  }
}
