import type { ImportInfo } from "../../../types/analysis.js";

/**
 * Rust `use` declarations, whole: a declaration may span lines and nest braces
 * (`use league_db_schema::{\n  source::{site::Site, community::Community},\n  traits::Crud,\n};`),
 * and the per-line pattern read only the single-line ones — a file importing
 * its models in the common multi-line form imported nothing, so its
 * `Site::read(…)` calls had no type to resolve against. Each leaf is an import
 * of its parent path naming the leaf (or its `as` alias, with the leaf in
 * `aliases`): `{ source: "league_db_schema::source::site", specifiers: ["Site"] }`; a glob
 * (`traits::*`) imports the module itself with no specifier. Imports of one
 * declaration sharing a parent path are grouped. A `mod x;` declaration is an
 * import of `x` from `self`.
 */
export function extractRustImports(lines: string[]): ImportInfo[] {
  const text = lines.join("\n");
  const out: ImportInfo[] = [];
  // `mod tools;` loads the child module `tools.rs` / `tools/mod.rs` and binds its name:
  // an import of `tools` from the module itself (`self`).
  if (text.includes("mod ")) {
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?([A-Za-z_]\w*)\s*;/gm)) {
      out.push({ source: "self", specifiers: [m[1]!], isDefault: false, isNamespace: false, isType: false, line: text.slice(0, m.index).split("\n").length });
    }
  }
  if (!text.includes("use ")) return out;
  const re = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index).split("\n").length;
    // ` as ` survives the whitespace collapse as a marker.
    const body = m[1]!.replace(/\/\/[^\n]*/g, "").replace(/\s+as\s+/g, "@as@").replace(/\s+/g, "");
    const bySource = new Map<string, string[]>();
    const aliasesBySource = new Map<string, Record<string, string>>();
    for (const leaf of expand(body)) {
      const alias = /^(.*)@as@(\w+)$/.exec(leaf);
      const path = (alias ? alias[1]! : leaf).replace(/::$/, "");
      const name = alias ? alias[2]! : path.slice(path.lastIndexOf("::") + 2);
      if (path.endsWith("*")) {
        const source = path.replace(/::\*$/, "");
        if (!bySource.has(source)) bySource.set(source, []);
        continue;
      }
      const cut = path.lastIndexOf("::");
      // `use serde;` / `use self::x` alone: the path is the import.
      const source = cut < 0 ? path : path.slice(0, cut);
      const list = bySource.get(source) ?? bySource.set(source, []).get(source)!;
      if (name === "self") continue;
      if (cut >= 0 && !list.includes(name)) list.push(name);
      // `Car as Motor`: the file names the module's `Car` as `Motor`.
      const original = path.slice(cut + 2);
      if (alias && cut >= 0 && name !== "_" && name !== original) {
        (aliasesBySource.get(source) ?? aliasesBySource.set(source, {}).get(source)!)[name] = original;
      }
    }
    for (const [source, specifiers] of bySource) {
      const aliases = aliasesBySource.get(source);
      out.push({ source, specifiers, isDefault: false, isNamespace: specifiers.length === 0, isType: false, line, ...(aliases ? { aliases } : {}) });
    }
  }
  return out;
}

/** `a::{b::{c,d},e}` → `a::b::c`, `a::b::d`, `a::e`. */
function expand(body: string): string[] {
  const open = body.indexOf("{");
  if (open < 0) return [body];
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [];
  const prefix = body.slice(0, open);
  const out: string[] = [];
  for (const part of splitTop(body.slice(open + 1, close))) {
    if (!part) continue;
    for (const leaf of expand(part)) out.push(leaf === "self" ? prefix.replace(/::$/, "") + "::self" : prefix + leaf);
  }
  return out;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
