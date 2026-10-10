import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { commonPrefixLength } from "../shared/path-utils.js";
import { companionStem } from "./companion.js";

/**
 * Delphi form → handler bridge. A .dfm wires events by NAME only
 * (`OnClick = btnCloseClick`); the method lives in the companion unit's form
 * class (`procedure TfrmMain.btnCloseClick(Sender: TObject);`). Nothing in
 * either file is a call, so the generic symbol linker never connects them —
 * exactly the WinForms Designer/partial-class situation (see
 * `CsharpUiBridgeResolver`), with the form CLASS declared in the .dfm root
 * (`object frmMain: TfrmMain`) naming the join key.
 *
 * Emits `<dfm file>::<component> → <pas file>::<TForm>.<handler>` links
 * (confidence INFERRED) — the shape the click-trace funnel resolves via its
 * callName fallback. Candidates joined by class name; the companion unit
 * (same path, .pas/.pp extension) wins outright, otherwise the longest
 * common path prefix does. Handlers inherited from a base form are found by
 * climbing `extends` one unit at a time.
 */
export class PascalUiBridgeResolver implements DispatchResolver {
  readonly id = "dfm-ui";
  readonly languages: Language[] = ["pascal", "dfm"];
  readonly priority = 20;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const byClass = new Map<string, { file: string; cls: ClassInfo }[]>();
    for (const a of analyses) {
      if (a.language !== "pascal") continue;
      for (const cls of a.classes ?? []) {
        const list = byClass.get(cls.name.toLowerCase()) ?? [];
        list.push({ file: a.filePath, cls });
        byClass.set(cls.name.toLowerCase(), list);
      }
    }
    if (byClass.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();

    for (const a of analyses) {
      if (a.language !== "dfm") continue;
      const els = a.interactiveElements ?? [];
      if (els.length === 0) continue;
      // Root form class, declared by the .dfm itself (`object frmMain: TfrmMain`).
      const formClass = a.classes?.[0]?.name;
      if (!formClass) continue;

      for (const el of els) {
        const handler = el.handler;
        if (!handler || !/^[A-Za-z_]\w*$/.test(handler)) continue;
        const hit = this.findHandler(byClass, formClass, handler, a.filePath);
        if (!hit) continue;
        const key = `${a.filePath}|${el.line}|${hit.file}|${hit.cls.name}.${hit.method.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          sourceFile: a.filePath,
          sourceSymbol: "<component>",
          sourceLine: el.line,
          callName: handler,
          targetFile: hit.file,
          targetSymbol: `${hit.cls.name}.${hit.method.name}`,
          targetLine: hit.method.line,
          confidence: "INFERRED",
        });
      }
    }
    return links;
  }

  /** Handler lookup in the form class, climbing `extends` (visual form
   *  inheritance) when the form itself doesn't declare it. */
  private findHandler(
    byClass: Map<string, { file: string; cls: ClassInfo }[]>,
    formClass: string,
    handler: string,
    dfmFile: string,
  ): { file: string; cls: ClassInfo; method: FunctionInfo } | null {
    const companion = companionStem(dfmFile);
    let className: string | null = formClass;
    const visited = new Set<string>();
    while (className && !visited.has(className.toLowerCase())) {
      visited.add(className.toLowerCase());
      const candidates: { file: string; cls: ClassInfo }[] = byClass.get(className.toLowerCase()) ?? [];
      let best: { file: string; cls: ClassInfo; method: FunctionInfo } | null = null;
      let bestScore = -1;
      let nextParent: string | null = null;
      for (const c of candidates) {
        nextParent ??= c.cls.extends;
        const method = c.cls.methods.find((m: FunctionInfo) => m.name.toLowerCase() === handler.toLowerCase());
        if (!method) continue;
        // The companion unit (same basename) beats any path-prefix score.
        const isCompanion = companionStem(c.file) === companion;
        const score = isCompanion ? Number.MAX_SAFE_INTEGER : commonPrefixLength(c.file, dfmFile);
        if (score > bestScore) {
          bestScore = score;
          best = { file: c.file, cls: c.cls, method };
        }
      }
      if (best) return best;
      className = nextParent;
    }
    return null;
  }
}
