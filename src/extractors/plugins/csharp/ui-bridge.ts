import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { commonPrefixLength } from "../shared/path-utils.js";

/**
 * C# desktop UI → handler bridge. Two indirections the generic symbol linker
 * can't see:
 *
 *   1. WinForms partial classes: the wiring (`MnuOpenFile.Click +=
 *      MnuOpenFile_Click;`) sits in `FrmMain.Designer.cs`, the handler method
 *      in another partial-class file (`FrmMain.cs`, `FrmMain/FrmMain.IGMethods.cs`).
 *      `+=` is not a call, so no call edge exists in either direction.
 *   2. XAML code-behind: `Click="ButtonCopy_Click"` in `Foo.axaml` names a
 *      method of the class `x:Class` declares, implemented in `Foo.axaml.cs`.
 *
 * Both produce synthetic `<ui file>::<site> → <cs file>::<Class>.<handler>`
 * links (confidence INFERRED), exactly the shape the click-trace funnel
 * resolves via its callName fallback. Joined by CLASS NAME; when several
 * classes share a name (e.g. two app versions vendored in one repo), the
 * candidate whose path shares the longest prefix with the UI file wins.
 */
export class CsharpUiBridgeResolver implements DispatchResolver {
  // VB is included for MAUI/WPF projects with VB code-behind — the partial-class
  // join is language-agnostic (classes + methods).
  readonly languages: Language[] = ["csharp", "vb", "xaml"];

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    // class name → declaring analyses (with the class itself).
    const byClass = new Map<string, { file: string; cls: ClassInfo }[]>();
    for (const a of analyses) {
      if (a.language === "xaml") continue;
      for (const cls of a.classes ?? []) {
        const list = byClass.get(cls.name) ?? [];
        list.push({ file: a.filePath, cls });
        byClass.set(cls.name, list);
      }
    }
    if (byClass.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const add = (l: SymbolLink) => {
      const k = `${l.sourceFile}|${l.sourceSymbol}|${l.sourceLine}|${l.targetFile}|${l.targetSymbol}`;
      if (!seen.has(k)) {
        seen.add(k);
        links.push(l);
      }
    };

    for (const a of analyses) {
      const els = a.interactiveElements ?? [];
      if (els.length === 0) continue;

      if (a.language === "xaml") {
        // Owner class: x:Class leaf (stored as the screen name) or the basename.
        const base = a.filePath.replace(/\\/g, "/").split("/").pop()!.replace(/\.(axaml|xaml)$/i, "");
        const ownerName = a.screens?.[0]?.name ?? base;
        const candidates = byClass.get(ownerName) ?? [];
        for (const el of els) {
          const hit = findHandler(candidates, el.handler, a.filePath);
          if (!hit) continue;
          add({
            sourceFile: a.filePath,
            sourceSymbol: "<component>",
            sourceLine: el.line,
            callName: el.handler!,
            targetFile: hit.file,
            targetSymbol: `${hit.cls.name}.${hit.method.name}`,
            targetLine: hit.method.line,
            confidence: "INFERRED",
          });
        }
        continue;
      }

      // C# side: wiring whose handler is declared in ANOTHER file of the same
      // (partial) class. Same-file handlers already resolve without help.
      const ownCls = a.classes?.[0];
      if (!ownCls) continue;
      const ownMethods = new Set((a.classes ?? []).flatMap((c) => c.methods.map((m) => m.name)));
      const partners = (byClass.get(ownCls.name) ?? []).filter((p) => p.file !== a.filePath);
      if (partners.length === 0) continue;
      const hasInit = ownCls.methods.some((m) => m.name === "InitializeComponent");
      const sourceSymbol = hasInit ? `${ownCls.name}.InitializeComponent` : "<wiring>";
      for (const el of els) {
        if (!el.handler || ownMethods.has(el.handler)) continue;
        const hit = findHandler(partners, el.handler, a.filePath);
        if (!hit) continue;
        add({
          sourceFile: a.filePath,
          sourceSymbol,
          sourceLine: el.line,
          callName: el.handler,
          targetFile: hit.file,
          targetSymbol: `${hit.cls.name}.${hit.method.name}`,
          targetLine: hit.method.line,
          confidence: "INFERRED",
        });
      }
    }
    return links;
  }
}

/** Best candidate declaring `handler` as a method — longest common path prefix
 *  with the UI file wins (disambiguates same-named classes across vendored
 *  app versions). */
function findHandler(
  candidates: { file: string; cls: ClassInfo }[],
  handler: string | null,
  uiFile: string,
): { file: string; cls: ClassInfo; method: FunctionInfo } | null {
  if (!handler || !/^[A-Za-z_]\w*$/.test(handler)) return null;
  let best: { file: string; cls: ClassInfo; method: FunctionInfo } | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const method = c.cls.methods.find((m) => m.name === handler);
    if (!method) continue;
    const score = commonPrefixLength(c.file, uiFile);
    if (score > bestScore) {
      bestScore = score;
      best = { file: c.file, cls: c.cls, method };
    }
  }
  return best;
}
