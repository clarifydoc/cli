import type { FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * A markdown renderer library walks the document and calls, on the subclass it was handed, the method named for
 * each node type — `def link(node)`, `def text(node)` — so no line of the project calls those methods. The
 * methods count as reached from wherever the subclass's `render` is called: the caller gets a `dispatch` link
 * to each `name(node)`-shaped method of the subclass.
 *
 * Only the dispatching bases listed here (a real library's names, nothing a project invents), only a call whose
 * receiver the extractor typed as the subclass (`MyRenderer.new.render(doc)`, a local built from it), and only
 * a method taking exactly the node.
 */
const DISPATCHING_BASES: ReadonlySet<string> = new Set(["CommonMarker::HtmlRenderer", "CommonMarker::Renderer", "Commonmarker::HtmlRenderer", "Commonmarker::Renderer"]);
/** Methods of such a subclass the library never dispatches by node type. */
const NOT_NODE_METHODS: ReadonlySet<string> = new Set(["initialize", "render", "document", "out", "plain", "code_block_in_pre"]);

interface Sub { file: string; name: string; handlers: FunctionInfo[] }

const leaf = (name: string): string => name.slice(name.lastIndexOf(":") + 1);

export class RubyNodeRendererResolver implements DispatchResolver {
  readonly id = "ruby-node-renderer";
  readonly languages: Language[] = ["ruby"];
  readonly priority = 58;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const subs: Sub[] = [];
    for (const a of analyses) {
      if (a.language !== "ruby") continue;
      for (const c of a.classes) {
        if (!c.extends || !DISPATCHING_BASES.has(c.extends.replace(/^::/, ""))) continue;
        const handlers = c.methods.filter((m) => m.params.length === 1 && !NOT_NODE_METHODS.has(m.name) && !m.name.endsWith("=") && !m.name.startsWith("_"));
        if (handlers.length > 0) subs.push({ file: a.filePath, name: c.name, handlers });
      }
    }
    if (subs.length === 0) return [];
    // A receiver type names a subclass by its full name, or by its leaf when only one subclass has it.
    const subOf = (type: string | undefined): Sub | null => {
      if (!type) return null;
      const exact = subs.filter((s) => s.name === type.replace(/^::/, ""));
      if (exact.length === 1) return exact[0]!;
      const byLeaf = subs.filter((s) => leaf(s.name) === leaf(type));
      return exact.length === 0 && byLeaf.length === 1 ? byLeaf[0]! : null;
    };

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of analyses) {
      if (a.language !== "ruby") continue;
      const units: Array<{ symbol: string; fn: FunctionInfo }> = [
        ...a.functions.map((fn) => ({ symbol: fn.name, fn })),
        ...a.classes.flatMap((c) => c.methods.map((fn) => ({ symbol: `${c.name}.${fn.name}`, fn }))),
      ];
      for (const { symbol, fn } of units) {
        for (const call of fn.calls) {
          if (call.name.split(".").pop() !== "render") continue;
          const head = call.name.includes(".") ? call.name.slice(0, call.name.indexOf(".")) : "";
          const sub = subOf(call.receiverType) ?? subOf(fn.localTypes?.find((l) => l.name === head && !l.from)?.type);
          if (!sub) continue;
          for (const h of sub.handlers) {
            const key = `${a.filePath}\0${symbol}\0${sub.file}\0${h.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({
              sourceFile: a.filePath, sourceSymbol: symbol, sourceLine: call.line, callName: call.name,
              targetFile: sub.file, targetSymbol: `${sub.name}.${h.name}`, targetLine: h.line,
              resolvedBy: "text", confidence: "INFERRED", relation: "dispatch",
            });
          }
        }
      }
    }
    return links;
  }
}
