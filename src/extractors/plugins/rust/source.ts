/**
 * Rust source preparation for the line-based spec: the text of every string
 * literal that spans lines is blanked, line structure and columns kept. Such a
 * string holds code-shaped text — a test fixture's `fn main() {}`, an embedded
 * script, a SQL statement — that the spec would otherwise read as functions
 * and calls (15 phantom functions in one embedding-quality test file).
 *
 * Covers `"…"`, byte strings `b"…"`, and raw strings `r"…"` / `r#"…"#` /
 * `br##"…"##`. One-line strings stay: routes and URLs are read from them.
 * Comments are kept as written (the spec's comment prefixes see `//`); a
 * quote inside a comment or a character literal (`'"'`) opens nothing.
 */
export function blankRustMultilineStrings(source: string): string {
  if (!source.includes('"')) return source;
  const blank = (s: string): string => s.replace(/[^\r\n]/g, " ");
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl < 0 ? n : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = blockCommentEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      // A char literal (`'"'`, `'\''`, `'\u{1F600}'`); a lifetime (`'a`) has no closing tick.
      const ch = /^'(?:\\(?:u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|.)|[^'\\\n])'/.exec(source.slice(i, i + 12));
      if (ch) {
        out += ch[0];
        i += ch[0].length;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    const raw = /^(b?r)(#*)"/.exec(source.slice(i, i + 40));
    if (raw && !isIdentChar(source[i - 1])) {
      const open = raw[0];
      const close = `"${raw[2]}`;
      const endQuote = source.indexOf(close, i + open.length);
      const end = endQuote < 0 ? n : endQuote + close.length;
      out += literal(source.slice(i, end), open.length, endQuote < 0 ? 0 : close.length, blank);
      i = end;
      continue;
    }
    if (c === '"' || (c === "b" && source[i + 1] === '"' && !isIdentChar(source[i - 1]))) {
      const start = i;
      let j = c === "b" ? i + 2 : i + 1;
      while (j < n && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const openLen = c === "b" ? 2 : 1;
      out += literal(source.slice(start, end), openLen, j < n ? 1 : 0, blank);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** A literal kept whole on one line; across lines, its delimiters kept and its text blanked. */
function literal(text: string, openLen: number, closeLen: number, blank: (s: string) => string): string {
  if (!/[\r\n]/.test(text)) return text;
  return text.slice(0, openLen) + blank(text.slice(openLen, text.length - closeLen)) + text.slice(text.length - closeLen);
}

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[\w]/.test(ch);
}

/** End offset of a (nesting) `/* … *\/` comment starting at `start`. */
function blockCommentEnd(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    if (source.startsWith("/*", i)) { depth++; i += 2; continue; }
    if (source.startsWith("*/", i)) { depth--; i += 2; if (depth === 0) return i; continue; }
    i++;
  }
  return source.length;
}

/** Path heads that are the language, the crate itself or a scope keyword, never a dependency. */
const NOT_A_CRATE = new Set(["std", "core", "alloc", "crate", "self", "super", "proc_macro", "test"]);

/**
 * Crates a file uses by path without a `use`: `serde_json::to_string(&x)`,
 * `#[derive(serde::Serialize)]`, `tokio::spawn(…)`. A head the file declares
 * itself (`mod models;`, `use x as models`) or imports is left out — the
 * imports already count. Comments are skipped; strings are already blank.
 */
export function rustPathHeads(source: string, imports: readonly { source: string; specifiers?: readonly string[] }[]): string[] {
  if (!source.includes("::")) return [];
  const local = new Set<string>();
  for (const m of source.matchAll(/\bmod\s+([a-z_][a-z0-9_]*)/g)) local.add(m[1]!);
  for (const m of source.matchAll(/\bas\s+([a-z_][a-z0-9_]*)\s*[;,}]/g)) local.add(m[1]!);
  for (const m of source.matchAll(/\b(?:let|fn|const|static|enum|struct|trait|type)\s+(?:mut\s+)?([a-z_][a-z0-9_]*)/g)) local.add(m[1]!);
  // An import's crate and every name it brings into scope (`use axum::{routing, extract}`).
  const imported = new Set(imports.flatMap((i) => [i.source.split("::")[0]!, i.source.split("::").pop()!, ...(i.specifiers ?? [])]));
  const out = new Set<string>();
  const code = source.replace(/\/\/[^\n]*/g, "");
  for (const m of code.matchAll(/(?<![\w:])([a-z_][a-z0-9_]*)::(?=[A-Za-z_{<*])/g)) {
    const head = m[1]!;
    if (NOT_A_CRATE.has(head) || local.has(head) || imported.has(head)) continue;
    // A `use` line is an import, not a path use.
    const lineStart = code.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s/.test(code.slice(lineStart, m.index))) continue;
    out.add(head);
  }
  return [...out].sort();
}
