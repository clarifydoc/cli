import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { buildFilePathMap, resolveTarget } from "../../shared/link-scoring.js";

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
 *
 * An element whose inline handler NAMES a function the page does not define —
 * `onclick="saveClub()"`, Alpine's `@click="changeRange"` — calls the function
 * of that name in the scripts the page loads (`<script src>`, a Blade
 * `@vite([...])` entry), or else in the modules those scripts import (an Alpine
 * component spread from `../shared/dates.js`): one link per handler, only when
 * exactly one function at the nearer level has that name.
 */
export class DomBindingResolver implements DispatchResolver {
  readonly id = "dom-binding";
  readonly languages: Language[] = ["javascript", "typescript", "html", "handlebars", "liquid", "velocity", "razor", "erb", "jsp", "php", "heex"];
  readonly priority = 43;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const scripts = analyses.filter((a) => SCRIPT_LANGUAGES.has(a.language));
    if (scripts.length === 0) return [];
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

    const links: SymbolLink[] = namedHandlerLinks(analyses, scripts);
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

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The file an import of `from` names: a relative specifier through the path map, else by path suffix, else the one file of that name. */
function importResolver(analyses: FileAnalysis[]): (source: string, from: FileAnalysis) => FileAnalysis | null {
  const filePathMap = buildFilePathMap(analyses);
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const byBase = new Map<string, FileAnalysis[]>();
  for (const a of analyses) {
    const base = a.filePath.slice(a.filePath.lastIndexOf("/") + 1);
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(a);
  }
  return (source, from) => {
    if (source.startsWith(".") && SCRIPT_LANGUAGES.has(from.language)) {
      const file = resolveTarget(source, from.filePath, filePathMap);
      return file ? byPath.get(file) ?? null : null;
    }
    const rel = source.replace(/[?#].*$/, "").replace(/^(?:\.{0,2}\/|~\/)+/, "");
    const named = byBase.get(rel.slice(rel.lastIndexOf("/") + 1)) ?? [];
    const bySuffix = named.filter((s) => s.filePath === rel || s.filePath.endsWith(`/${rel}`));
    if (bySuffix.length === 1) return bySuffix[0]!;
    return named.length === 1 && SCRIPT_LANGUAGES.has(named[0]!.language) ? named[0]! : null;
  };
}

/**
 * Links from each page to the functions its inline handlers name. A name is
 * looked up in the page's own scripts, then in what they import (two levels);
 * a partial, layout or component that loads no script of its own is looked up
 * the same way from each page that includes it (up to four includes up), so a
 * shared `<x-date-range>` whose `@click="changeRange"` lives in a module every
 * page script imports links once, and a shared form whose `save` each page
 * defines links to each page's `save`.
 */
function namedHandlerLinks(analyses: FileAnalysis[], scripts: FileAnalysis[]): SymbolLink[] {
  const pages = analyses.filter((a) => !SCRIPT_LANGUAGES.has(a.language));
  const wanted = pages
    .map((page) => ({ page, named: page.interactiveElements.filter((e) => !e.request && e.event.startsWith("on") && e.handler && IDENT.test(e.handler)) }))
    .filter((p) => p.named.length > 0);
  if (wanted.length === 0 || scripts.length === 0) return [];
  const resolveImport = importResolver(analyses);
  const loads = new Map<FileAnalysis, FileAnalysis[]>();
  const loadsOf = (a: FileAnalysis): FileAnalysis[] => {
    let out = loads.get(a);
    if (!out) loads.set(a, (out = [...new Set(a.imports.map((i) => resolveImport(i.source, a)).filter((f): f is FileAnalysis => !!f && f !== a))]));
    return out;
  };
  const includers = new Map<FileAnalysis, FileAnalysis[]>();
  for (const page of pages) {
    for (const loaded of loadsOf(page)) {
      if (!SCRIPT_LANGUAGES.has(loaded.language)) (includers.get(loaded) ?? includers.set(loaded, []).get(loaded)!).push(page);
    }
  }
  /** A page's scripts by level: those it loads, then what they import (two levels). */
  const levelCache = new Map<FileAnalysis, FileAnalysis[][]>();
  const levelsOf = (page: FileAnalysis): FileAnalysis[][] => {
    const cached = levelCache.get(page);
    if (cached) return cached;
    const first = loadsOf(page).filter((f) => SCRIPT_LANGUAGES.has(f.language));
    const levels: FileAnalysis[][] = first.length ? [first] : [];
    const seen = new Set(first);
    for (let depth = 0; depth < 2 && levels.length; depth++) {
      const next = [...new Set(levels[levels.length - 1]!.flatMap(loadsOf))].filter((s) => !seen.has(s) && SCRIPT_LANGUAGES.has(s.language));
      if (next.length === 0) break;
      for (const s of next) seen.add(s);
      levels.push(next);
    }
    levelCache.set(page, levels);
    return levels;
  };
  /** The one function named `name` at the nearest level of a page's scripts that has one. */
  const lookup = (page: FileAnalysis, name: string): { file: string; symbol: string; line: number } | null => {
    for (const level of levelsOf(page)) {
      const hits = level.flatMap((s) => s.functions.filter((f) => f.name === name || f.name.endsWith(`.${name}`)).map((f) => ({ file: s.filePath, symbol: f.name, line: f.line })));
      if (hits.length) return hits.length === 1 ? hits[0]! : null;
    }
    return null;
  };

  const out: SymbolLink[] = [];
  for (const { page, named } of wanted) {
    const own = new Set(page.functions.map((f) => f.name));
    const done = new Set<string>();
    for (const el of named) {
      const name = el.handler!;
      if (own.has(name) || done.has(name)) continue;
      done.add(name);
      const targets = new Map<string, { file: string; symbol: string; line: number }>();
      const direct = lookup(page, name);
      if (direct) targets.set(`${direct.file}::${direct.symbol}`, direct);
      else {
        // The pages this one is part of, nearest first.
        const seen = new Set([page]);
        let frontier = [page];
        for (let depth = 0; depth < 4 && frontier.length && targets.size === 0; depth++) {
          const next: FileAnalysis[] = [];
          for (const p of frontier) for (const up of includers.get(p) ?? []) if (!seen.has(up)) (seen.add(up), next.push(up));
          for (const up of next) {
            const hit = lookup(up, name);
            if (hit) targets.set(`${hit.file}::${hit.symbol}`, hit);
          }
          frontier = next;
        }
      }
      for (const t of targets.values()) {
        out.push({
          sourceFile: page.filePath,
          sourceSymbol: "<component>",
          sourceLine: el.line,
          callName: name,
          targetFile: t.file,
          targetSymbol: t.symbol,
          targetLine: t.line,
          confidence: "INFERRED",
        });
      }
    }
  }
  return out;
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
