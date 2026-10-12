import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

const sameVerb = (a: string | null, b: string): boolean =>
  a === null || a === b || ((a === "PUT" || a === "PATCH") && (b === "PUT" || b === "PATCH"));

/**
 * Phoenix markup → server code. Two joins, both from what the markup states:
 *   - a `phx-*="event"` element → the `handle_event("event")` clause of the
 *     LiveView (or LiveComponent) that renders it: the module whose lines hold
 *     an inline `~H` element, or for a co-located template
 *     (`settings_live.html.heex`) the module in `settings_live.ex`;
 *   - a link or form `request` (literal path, interpolations as `:param`) → the
 *     Phoenix route serving that path and verb, and from there the controller
 *     action (`SiteController.settings` — the route names its controller
 *     relative to the scope alias, so the module is the ONE whose name ends so).
 * Each link goes from the markup's handler symbol to the server function.
 */
export class PhoenixEventResolver implements DispatchResolver {
  readonly id = "phoenix-event";
  readonly languages: Language[] = ["elixir", "heex"];
  readonly priority = 41;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const marked = analyses.filter((a) => a.interactiveElements.some((e) => e.event.startsWith("phx-") || e.request));
    if (marked.length === 0) return [];
    const elixir = analyses.filter((a) => a.language === "elixir");
    const byPath = new Map(elixir.map((a) => [a.filePath, a]));

    const eventClause = (file: FileAnalysis, line: number | null, event: string): { cls: ClassInfo; line: number } | null => {
      const name = `handle_event("${event}")`;
      const classes = line === null ? file.classes : file.classes.filter((c) => c.line <= line && line <= c.endLine);
      // Innermost module first: a LiveComponent nested in a LiveView file handles its own events.
      for (const cls of [...classes].sort((a, b) => b.line - a.line)) {
        const m = cls.methods.find((x) => x.name === name);
        if (m) return { cls, line: m.line };
      }
      return null;
    };

    // Phoenix routes with a dotted controller handler (`SiteController.settings`).
    const routes: Array<{ verb: string | null; re: RegExp; ctl: string; action: string }> = [];
    for (const a of elixir) {
      for (const r of a.routes) {
        const m = /^([A-Z][\w.]*)\.([a-z_]\w*[?!]?)$/.exec(r.handler ?? "");
        if (!m || r.kind !== "api") continue;
        const pattern = r.path.split("/").map((s) => (s.startsWith(":") || s.startsWith("*") ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
        routes.push({ verb: r.httpMethod, re: new RegExp(`^${pattern}/?$`), ctl: m[1]!, action: m[2]! });
      }
    }
    const actionSite = (ctl: string, action: string): { file: string; symbol: string; line: number } | null => {
      const hits: Array<{ file: string; symbol: string; line: number }> = [];
      for (const a of elixir) {
        for (const cls of a.classes) {
          if (cls.name !== ctl && !cls.name.endsWith(`.${ctl}`)) continue;
          const m = cls.methods.find((x) => x.name === action);
          if (m) hits.push({ file: a.filePath, symbol: `${cls.name}.${m.name}`, line: m.line });
        }
      }
      return hits.length === 1 ? hits[0]! : null;
    };

    const links: SymbolLink[] = [];
    const emitted = new Set<string>();
    const push = (a: FileAnalysis, handler: string, line: number, target: { file: string; symbol: string; line: number }): void => {
      const key = `${a.filePath}\0${handler}\0${target.file}\0${target.symbol}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      links.push({ sourceFile: a.filePath, sourceSymbol: handler, sourceLine: line, callName: handler, targetFile: target.file, targetSymbol: target.symbol, targetLine: target.line, confidence: "INFERRED" });
    };

    for (const a of marked) {
      const colocated = a.language === "heex" ? byPath.get(a.filePath.replace(/\.html\.(?:heex|leex)$|\.(?:heex|leex)$/, ".ex")) : undefined;
      for (const el of a.interactiveElements) {
        if (!el.handler) continue;
        if (el.event.startsWith("phx-")) {
          const owner = a.language === "elixir" ? a : colocated;
          const hit = owner ? eventClause(owner, a.language === "elixir" ? el.line : null, el.handler) : null;
          if (hit && owner) push(a, el.handler, el.line, { file: owner.filePath, symbol: `${hit.cls.name}.handle_event("${el.handler}")`, line: hit.line });
        } else if (el.request) {
          const target = el.request.target.replace(/\/$/, "") || "/";
          for (const r of routes) {
            if (!sameVerb(r.verb, el.request.method) || !r.re.test(target)) continue;
            const site = actionSite(r.ctl, r.action);
            if (site) push(a, el.handler, el.line, site);
          }
        }
      }
    }
    return links;
  }
}
