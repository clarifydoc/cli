import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

const SCRIPT_LANGUAGES = new Set<Language>(["javascript", "typescript"]);

/**
 * A server-rendered page's buttons and the functions its scripts bind to them
 * by selector: `<button vw-delete-club>` in the page, and in the script it loads
 * with `<script src=…/clubs.js>`,
 *
 *   document.querySelectorAll("button[vw-delete-club]").forEach((b) => b.addEventListener("click", deleteClub));
 *
 * Each element whose `selector` the binding's selector matches (its last
 * compound: tag, id, classes, attributes — all must be on the element) gets a
 * link from the page's `<component>` to the handler, in the script that binds
 * it or another script the page loads; an inline handler is the function the
 * binding sits in. A selector that names only a tag binds nothing.
 */
export class DomBindingResolver implements DispatchResolver {
  readonly id = "dom-binding";
  readonly languages: Language[] = ["javascript", "typescript", "html", "handlebars", "liquid", "velocity", "razor", "erb", "jsp", "php", "heex"];
  readonly priority = 43;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const scripts = analyses.filter((a) => SCRIPT_LANGUAGES.has(a.language));
    if (!scripts.some((s) => s.domBindings?.length)) return [];
    const byBase = new Map<string, FileAnalysis[]>();
    for (const s of scripts) {
      const base = s.filePath.slice(s.filePath.lastIndexOf("/") + 1);
      (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(s);
    }
    /** The script a page's `<script src>` names: by path suffix, else the one file of that name. */
    const scriptOf = (src: string): FileAnalysis | null => {
      const rel = src.replace(/[?#].*$/, "").replace(/^(?:\.{0,2}\/|~\/)+/, "");
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      const named = byBase.get(base) ?? [];
      const bySuffix = named.filter((s) => s.filePath === rel || s.filePath.endsWith(`/${rel}`));
      if (bySuffix.length === 1) return bySuffix[0]!;
      return named.length === 1 ? named[0]! : null;
    };

    const links: SymbolLink[] = [];
    for (const page of analyses) {
      if (SCRIPT_LANGUAGES.has(page.language)) continue;
      const elements = page.interactiveElements.filter((e) => e.selector);
      if (elements.length === 0) continue;
      const loaded = [...new Set(page.imports.map((i) => scriptOf(i.source)).filter((s): s is FileAnalysis => !!s))];
      for (const script of loaded) {
        for (const b of script.domBindings ?? []) {
          const target = handlerIn(b.handler, b.line, script, loaded);
          if (!target) continue;
          const wanted = b.selector.split(",").map((s) => parseCompound(lastCompound(s))).filter((c) => c.id || c.classes.length || c.attrs.length);
          for (const el of elements) {
            const have = parseCompound(el.selector!);
            if (!wanted.some((w) => matches(w, have))) continue;
            links.push({
              sourceFile: page.filePath,
              sourceSymbol: "<component>",
              sourceLine: el.line,
              callName: target.symbol,
              targetFile: target.file,
              targetSymbol: target.symbol,
              targetLine: target.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/** The function a binding runs: named — in its script, else in another the page loads — or, inline, the function it sits in. */
function handlerIn(name: string | null, line: number, script: FileAnalysis, loaded: FileAnalysis[]): { file: string; symbol: string; line: number } | null {
  if (name) {
    for (const s of [script, ...loaded.filter((l) => l !== script)]) {
      const fn = s.functions.find((f) => f.name === name);
      if (fn) return { file: s.filePath, symbol: fn.name, line: fn.line };
    }
    return null;
  }
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of script.functions) if (f.line <= line && line <= f.endLine && (!best || f.line >= best.line)) best = f;
  return best ? { file: script.filePath, symbol: best.name, line: best.line } : null;
}

interface Compound {
  tag: string;
  id: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

/** `div.list button[data-x]` → `button[data-x]`: the elements the selector ends on. */
function lastCompound(selector: string): string {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/);
  return parts[parts.length - 1] ?? "";
}

function parseCompound(text: string): Compound {
  const out: Compound = { tag: "", id: "", classes: [], attrs: [] };
  const attrRe = /\[\s*([\w:-]+)\s*(?:[~|^$*]?=\s*["']?([^"'\]]*)["']?)?\s*\]/g;
  for (const m of text.matchAll(attrRe)) out.attrs.push({ name: m[1]!.toLowerCase(), ...(m[2] !== undefined ? { value: m[2] } : {}) });
  const rest = text.replace(attrRe, "").replace(/:[\w-]+(?:\([^)]*\))?/g, "");
  out.tag = /^[a-z][\w-]*/i.exec(rest)?.[0].toLowerCase() ?? "";
  for (const m of rest.matchAll(/([#.])([\w-]+)/g)) {
    if (m[1] === "#") out.id = m[2]!;
    else out.classes.push(m[2]!);
  }
  return out;
}

/** Everything the binding asks for is on the element. */
function matches(want: Compound, el: Compound): boolean {
  if (want.tag && want.tag !== el.tag) return false;
  if (want.id && want.id !== el.id) return false;
  if (!want.classes.every((c) => el.classes.includes(c))) return false;
  return want.attrs.every((a) => el.attrs.some((e) => e.name === a.name && (a.value === undefined || e.value === a.value)));
}
