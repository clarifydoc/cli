import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Lightning Web Component template → component class. A component is a folder `lwc/clubList/` holding
 * `clubList.js` (a class extending `LightningElement`, from the `lwc` module) and `clubList.html`, whose
 * `onclick={handleSave}` names a method of that class; nothing in the markup says which file holds it. Each
 * element whose handler the class declares links from the template's `<component>` anchor to that method, and
 * the template to what runs when the component connects: its `connectedCallback` and the file's `<setup>`,
 * where its wired adapters are called.
 */

/** The template beside a component's script, by the folder-and-file naming LWC requires. */
function templatePath(filePath: string): string | null {
  const m = /^(.*\/lwc\/([^/]+)\/)\2\.(?:js|ts)$/.exec(filePath);
  return m ? `${m[1]}${m[2]}.html` : null;
}

export class LwcTemplateResolver implements DispatchResolver {
  readonly id = "lwc-template";
  readonly languages: Language[] = ["javascript", "typescript", "html"];
  readonly priority = 58;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const byPath = new Map<string, FileAnalysis>();
    const components: Array<{ a: FileAnalysis; html: string }> = [];
    for (const a of analyses) {
      byPath.set(a.filePath, a);
      const html = templatePath(a.filePath);
      if (html && a.imports.some((i) => i.source === "lwc")) components.push({ a, html });
    }
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const { a, html } of components) {
      const view = byPath.get(html);
      const cls = a.classes.find((c) => c.extends === "LightningElement");
      if (!view || !cls) continue;
      const to = (symbol: string, line: number, targetLine: number, callName: string): void => {
        const key = `${view.filePath}\0${line}\0${symbol}`;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ sourceFile: view.filePath, sourceSymbol: "<component>", sourceLine: line, callName, targetFile: a.filePath, targetSymbol: symbol, targetLine, confidence: "INFERRED" });
      };
      const methods = new Map(cls.methods.map((m) => [m.name, m]));
      for (const el of view.interactiveElements) {
        const m = el.handler ? methods.get(el.handler) : undefined;
        if (m) to(`${cls.name}.${m.name}`, el.line, m.line, el.handler!);
      }
      const connected = methods.get("connectedCallback");
      if (connected) to(`${cls.name}.connectedCallback`, 1, connected.line, "connectedCallback");
      const setup = a.functions.find((f) => f.name === "<setup>");
      if (setup) to("<setup>", 1, setup.line, "<setup>");
    }
    return links;
  }
}
