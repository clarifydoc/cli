import type { FileAnalysis } from "../../../types/analysis.js";
import { closingAt, splitTopLevel } from "./data-sources.js";

/**
 * A URL helper — `fn club_url(id: u32) -> String { format!("/api/v1/clubs/{}", id) }` — states the URL its call
 * builds: `FunctionInfo.urlTemplate`, the path with each parameter as `{name}`, a literal argument as written, a
 * constant (`BASE`, `self.origin`) as a `${…}` hole, anything else `{}`. A call of it handed to a client verb in
 * another file (`client.get(urls::club_url(id))`) is joined to the helper by the project pass, which fills
 * the parameters with the call's arguments. Only a function whose whole body is one `format!` with a literal
 * template holding a `/` — the same helper the reading of a request in its own file accepts.
 */
export function addRustUrlTemplates(analysis: FileAnalysis, lines: readonly string[]): void {
  if (!analysis.functions.some((f) => f.line >= 1 && f.name !== "<setup>")) return;
  for (const fn of analysis.functions) {
    if (fn.name === "<setup>" || fn.name.includes(".") || fn.urlTemplate || fn.endLine < fn.line) continue;
    const text = lines.slice(fn.line - 1, fn.endLine).join("\n");
    if (!text.includes("format!")) continue;
    const params = fn.params.map((p) => p.name.replace(/^mut\s+/, "")).filter((p) => p && p !== "self");
    const open = text.indexOf("(");
    const paramsEnd = open < 0 ? -1 : closingAt(text, open);
    const bodyStart = paramsEnd < 0 ? -1 : text.indexOf("{", paramsEnd);
    if (bodyStart < 0) continue;
    const bodyEnd = closingAt(text, bodyStart);
    if (bodyEnd < 0 || text.slice(bodyEnd + 1).trim()) continue;
    const fmt = /^\s*(?:return\s+)?format!\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,?([\s\S]*)\)\s*;?\s*$/.exec(text.slice(bodyStart + 1, bodyEnd));
    if (!fmt) continue;
    const template = templateOf(fmt[1]!, splitTopLevel(fmt[2]!).map((a) => a.trim().replace(/^&\s*(?:mut\s+)?/, "")), new Set(params));
    if (template) fn.urlTemplate = template;
  }
}

/** The format string with each placeholder replaced as `addRustUrlTemplates` says; null unless it is URL-shaped. */
function templateOf(format: string, args: string[], params: ReadonlySet<string>): string | null {
  let next = 0;
  const value = (expr: string | undefined): string => {
    if (expr === undefined) return "{}";
    const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(expr);
    if (lit) return lit[1]!;
    if (params.has(expr)) return `{${expr}}`;
    return /^[A-Za-z_][\w.]*$/.test(expr) ? `\${${expr}}` : "{}";
  };
  const out = format.replace(/\{\{|\}\}|\{([A-Za-z_]\w*|\d+)?(?::[^}]*)?\}/g, (m, id: string | undefined) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (id === undefined) return value(args[next++]);
    return /^\d+$/.test(id) ? value(args[Number(id)]) : value(id);
  });
  return out.includes("/") ? out : null;
}
