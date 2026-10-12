import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * AppFlowy's lib-dispatch: a Rust plugin registers a handler per event of its
 * enum, and the Flutter side sends the event through a class generated from
 * the same enum.
 *
 *   AFPlugin::new().event(FolderEvent::CreateView, create_view_handler)   // Rust
 *   FolderEventCreateView(payload).send()                                 // Dart (generated)
 *
 * The generated Dart classes are not in the repository, so a Flutter click
 * dead-ended at a call nothing defines, one hop short of the Rust handler and
 * its database. The registration is read here (`extractEventRegistrations`),
 * and `AfDispatchResolver` joins the Dart call named `<Enum><Variant>` to the
 * handler the same crate defines under the registered name.
 */

// `.event(FolderEvent::CreateView, create_view_handler)`, possibly across lines.
const EVENT_RE = /\.event\(\s*([A-Z]\w*Event)::([A-Z]\w*)\s*,\s*([a-z_][\w:]*)\s*,?\s*\)/g;

export function extractEventRegistrations(lines: string[]): Array<{ message: string; handler: string; line: number }> {
  const text = lines.join("\n");
  if (!text.includes(".event(")) return [];
  const out: Array<{ message: string; handler: string; line: number }> = [];
  for (const m of text.matchAll(EVENT_RE)) {
    const line = text.slice(0, m.index).split("\n").length;
    out.push({ message: `${m[1]}::${m[2]}`, handler: m[3]!.split("::").pop()!, line });
  }
  return out;
}

export class AfDispatchResolver implements DispatchResolver {
  readonly id = "af-dispatch";
  readonly languages: Language[] = ["rust", "dart"];
  readonly priority = 45;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const registering = analyses.filter((a) => a.language === "rust" && a.messageHandlers?.length);
    if (registering.length === 0) return [];
    // The crate a file belongs to: the path up to its `src/`.
    const crateOf = (path: string) => path.slice(0, path.lastIndexOf("/src/") + 1) || path.slice(0, path.lastIndexOf("/") + 1);
    const fnsByCrate = new Map<string, Map<string, Array<{ file: string; name: string; line: number }>>>();
    for (const a of analyses) {
      if (a.language !== "rust") continue;
      const crate = crateOf(a.filePath);
      const byName = fnsByCrate.get(crate) ?? fnsByCrate.set(crate, new Map()).get(crate)!;
      for (const fn of a.functions) {
        const list = byName.get(fn.name) ?? byName.set(fn.name, []).get(fn.name)!;
        list.push({ file: a.filePath, name: fn.name, line: fn.line });
      }
    }
    // `FolderEventCreateView` → the handler registered for `FolderEvent::CreateView`.
    const handlers = new Map<string, { file: string; name: string; line: number } | null>();
    for (const a of registering) {
      const crate = fnsByCrate.get(crateOf(a.filePath));
      for (const reg of a.messageHandlers!) {
        const defs = crate?.get(reg.handler) ?? [];
        const key = reg.message.replace("::", "");
        // A handler name the crate defines twice, or a message two crates register, is not guessed.
        const def = defs.length === 1 ? defs[0]! : null;
        handlers.set(key, handlers.has(key) && handlers.get(key)?.file !== def?.file ? null : def);
      }
    }
    const links: SymbolLink[] = [];
    for (const a of analyses) {
      if (a.language !== "dart") continue;
      const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls) {
          const cls = /^([A-Z]\w*Event[A-Z]\w*)(?:\b|$)/.exec(call.name)?.[1];
          const target = cls ? handlers.get(cls) : undefined;
          if (!target) continue;
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: target.file,
            targetSymbol: target.name,
            targetLine: target.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
