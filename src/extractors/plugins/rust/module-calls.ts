import type { CallInfo, FileAnalysis } from "../../../types/analysis.js";
import { blockEndLine } from "../shared/regex-base.js";
import { rustSpec } from "./index.js";

/**
 * Calls through a module path, named as written (`tools::wrench`,
 * `crate::garage::tools::spanner`, `super::load`, `util::fmt::score`): each is
 * a call of the function `member` in the module its path names, which the
 * plugin's import rules resolve (module-resolver.ts) — so `target` is that
 * path, with a head the file brings in by name (`mod tools;`, `use
 * crate::garage::tools;`) spelled out through its import (`self::tools`,
 * `crate::garage::tools`). A path from a crate the analysis lacks (`std::mem`)
 * resolves to no file and links nothing. The member is the module's own item
 * (`moduleMember`): `store::sweep()` is never `impl Db { fn sweep(&self) }`.
 */
export function promoteModuleCalls(analysis: FileAnalysis, lines: string[]): void {
  const inline = inlineModuleSpans(lines);
  const imported = new Map<string, string>();
  // `#[path = "export.rs"] mod export_;` — a module whose file the attribute names: a call through it targets that file.
  const pathModules = new Map<string, string>();
  for (const imp of analysis.imports) {
    if (imp.source.startsWith(".")) for (const s of imp.specifiers) pathModules.set(s, imp.source);
  }
  for (const imp of analysis.imports) {
    for (const s of imp.specifiers) {
      if (imported.has(s)) continue;
      const name = imp.aliases?.[s] ?? s;
      imported.set(s, imp.source === "self" ? `self::${name}` : `${imp.source}::${name}`);
    }
  }
  const modules = inlineModules(lines);
  nameDuplicatesByModule(analysis, modules);
  const promote = (calls: CallInfo[]) => {
    for (const c of calls) {
      if (c.kind !== "internal" || c.name.includes(".") || !c.name.includes("::")) continue;
      const cut = c.name.lastIndexOf("::");
      const path = c.name.slice(0, cut);
      const member = c.name.slice(cut + 2);
      // `sys::ignite()` through `mod sys { pub fn ignite() {} }` of this very file: that function, when no
      // other function of the file shares its name (the per-file index cannot tell two apart).
      const inlineName = modules.length > 0 ? inlineModuleMember(analysis, modules, imported, c, path, member) : null;
      if (inlineName) {
        c.name = inlineName;
        continue;
      }
      let segs = path.split("::");
      // Inside `mod tests { … }` (and deeper inline modules) `super` climbs those first:
      // `super::helper()` there is the file's own `helper`.
      const depth = inline.filter(([from, to]) => c.line > from && c.line <= to).length;
      if (depth > 0 && segs[0] === "super") {
        let ups = 0;
        while (segs[ups] === "super") ups++;
        segs = ups <= depth ? ["self", ...segs.slice(ups)] : [...segs.slice(depth)];
      }
      const head = segs[0]!;
      const file = segs.length === 1 ? pathModules.get(head) : undefined;
      if (file) {
        c.kind = "cross-file";
        c.target = file;
        c.member = member;
        c.moduleMember = true;
        c.confidence = "EXTRACTED";
        continue;
      }
      const through = head === "crate" || head === "super" || head === "self" ? undefined : imported.get(head);
      c.kind = "cross-file";
      c.target = through ? [through, ...segs.slice(1)].join("::") : segs.join("::");
      c.member = member;
      c.moduleMember = true;
      c.confidence = "EXTRACTED";
    }
  };
  for (const fn of analysis.functions) promote(fn.calls);
  for (const cls of analysis.classes) for (const m of cls.methods) promote(m.calls);
}

/** Lines `[declared, closed]` of each inline module (`mod tests { … }`), 1-based. */
function inlineModuleSpans(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?\w+\s*\{/.test(lines[i]!)) spans.push([i + 1, blockEndLine(lines, i, rustSpec)]);
  }
  return spans;
}

interface InlineModule {
  /** The module's path from the file's own root (`outer::inner`). */
  path: string;
  from: number;
  to: number;
}

/** The inline modules of a file with their nested paths. */
function inlineModules(lines: string[]): InlineModule[] {
  const found: Array<{ name: string; from: number; to: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?(\w+)\s*\{/.exec(lines[i]!);
    if (m) found.push({ name: m[1]!, from: i + 1, to: blockEndLine(lines, i, rustSpec) });
  }
  return found.map((f) => ({
    path: found.filter((o) => o.from <= f.from && o.to >= f.to).map((o) => o.name).join("::"),
    from: f.from,
    to: f.to,
  }));
}

/**
 * Functions of one name declared in two inline modules of a file (`mod home { fn kick() }`, `mod away { fn kick() }`)
 * are named by their module path (`home::kick`), as a nested type is: the per-file index then tells them apart, and a
 * bare `kick()` from inside one module is the module's own. A bare call is the only call rewritten here.
 */
function nameDuplicatesByModule(analysis: FileAnalysis, modules: InlineModule[]): void {
  if (modules.length === 0) return;
  const count = new Map<string, number>();
  for (const f of analysis.functions) count.set(f.name, (count.get(f.name) ?? 0) + 1);
  const innermost = (line: number): InlineModule | null =>
    modules.filter((m) => line >= m.from && line <= m.to).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  const renamed = new Map<string, string>();
  for (const f of analysis.functions) {
    if ((count.get(f.name) ?? 0) < 2) continue;
    const mod = innermost(f.line);
    if (!mod) continue;
    const named = `${mod.path}::${f.name}`;
    renamed.set(`${mod.path}\0${f.name}`, named);
    f.name = named;
  }
  if (renamed.size === 0) return;
  for (const fn of analysis.functions) {
    for (const c of fn.calls) {
      if (c.kind !== "internal" || c.name.includes("::") || c.name.includes(".")) continue;
      const mod = innermost(c.line);
      const named = mod ? renamed.get(`${mod.path}\0${c.name}`) : undefined;
      if (named) c.name = named;
    }
  }
}

/** The name of the function the call `path::member` reaches when it is declared directly in an inline module of the same file, else null. */
function inlineModuleMember(analysis: FileAnalysis, modules: InlineModule[], imported: Map<string, string>, call: CallInfo, path: string, member: string): string | null {
  const here = modules.filter((m) => call.line >= m.from && call.line <= m.to).map((m) => m.path).sort((a, b) => b.length - a.length)[0] ?? "";
  const root = /(?:^|\/)(?:main|lib)\.rs$/.test(analysis.filePath);
  let segs = path.split("::");
  const head = segs[0]!;
  const through = head === "crate" || head === "super" || head === "self" ? undefined : imported.get(head);
  const candidates: string[] = [];
  const join = (...p: string[]) => p.filter(Boolean).join("::");
  if (through) {
    const full = [...through.split("::"), ...segs.slice(1)];
    if (full[0] === "crate" && root) candidates.push(full.slice(1).join("::"));
    else if (full[0] === "self") candidates.push(join(here, ...full.slice(1)));
  } else if (head === "crate") {
    if (root) candidates.push(segs.slice(1).join("::"));
  } else if (head === "self") {
    candidates.push(join(here, ...segs.slice(1)));
  } else if (head === "super") {
    let up = here.split("::").filter(Boolean);
    while (segs[0] === "super") {
      up = up.slice(0, -1);
      segs = segs.slice(1);
    }
    candidates.push(join(...up, ...segs));
  } else {
    candidates.push(join(here, ...segs));
    if (here) candidates.push(segs.join("::"));
  }
  const matched = modules.filter((m) => candidates.includes(m.path));
  if (matched.length !== 1) return null;
  const mod = matched[0]!;
  const deeper = modules.filter((m) => m.from > mod.from && m.to <= mod.to);
  const same = analysis.functions.filter((f) => f.name === member || f.name === `${mod.path}::${member}`);
  if (same.length !== 1) return null;
  const fn = same[0]!;
  return fn.line >= mod.from && fn.line <= mod.to && !deeper.some((m) => fn.line >= m.from && fn.line <= m.to) ? fn.name : null;
}
