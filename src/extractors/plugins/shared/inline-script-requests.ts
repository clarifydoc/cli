import type { DataSourceInfo } from "../../../types/analysis.js";
import { literalPath } from "./element-requests.js";

/**
 * Requests a page's inline `<script>` makes to its own app — `fetch("/signup/code", { method: "POST" })`,
 * `axios.post("/clubs")`, `$.getJSON("/fixtures")` — as api-calls named `VERB /path`, so the route
 * linker joins them as it joins a form. Scripts loaded by `src` are their own files (the JS plugin's).
 * Only a literal app path counts; its method is the options' `method`, else GET.
 */
const CALL_RE = /\bfetch\s*\(\s*(["'`])([^"'`]*)\1|\baxios\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^"'`]*)\4|\$\.(get|post|getJSON)\s*\(\s*(["'`])([^"'`]*)\7/g;

export function inlineScriptRequests(lines: readonly string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  let body: string[] | null = null;
  let start = 0;
  const flush = () => {
    const text = body!.join("\n");
    for (const m of text.matchAll(CALL_RE)) {
      const target = literalPath((m[2] ?? m[5] ?? m[8])!.replace(/\$\{([^}]*)\}/g, "{{$1}}"));
      if (!target) continue;
      let method = m[3] ?? (m[6] ? (m[6] === "post" ? "post" : "get") : null);
      if (!method) {
        // The options of this `fetch(…)`: up to the next request in the script.
        const after = text.slice(m.index! + m[0].length);
        const next = after.search(/\bfetch\s*\(|\baxios\.|\$\.(?:get|post|ajax)/);
        method = /\bmethod\s*:\s*["'`](\w+)["'`]/.exec(next < 0 ? after.slice(0, 400) : after.slice(0, Math.min(next, 400)))?.[1] ?? "get";
      }
      const verb = method.toUpperCase();
      out.push({ kind: "api-call", name: `${verb} ${target}`, target, calls: [], line: start + text.slice(0, m.index).split("\n").length });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (body) {
      const close = line.search(/<\/script\s*>/i);
      body.push(close < 0 ? line : line.slice(0, close));
      if (close >= 0) { flush(); body = null; }
      continue;
    }
    const open = /<script\b([^>]*)>/i.exec(line);
    if (!open || /\bsrc\s*=/.test(open[1]!) || /\btype\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(open[1]!)) continue;
    const rest = line.slice(open.index + open[0].length);
    const close = rest.search(/<\/script\s*>/i);
    body = [close < 0 ? rest : rest.slice(0, close)];
    start = i;
    if (close >= 0) { flush(); body = null; }
  }
  return out;
}
