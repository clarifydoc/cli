/**
 * Small Go lexical helpers shared by the class, local-type and DI-binding
 * passes. Everything here works on raw source text: strings, raw strings and
 * runes are skipped so a brace or `//` inside a struct tag or a literal never
 * moves a boundary.
 */

/** `line` without its `//` comment (a `//` inside a string, raw string or rune is kept). */
export function stripGoComment(line: string): string {
  if (!line.includes("//")) return line;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote !== "`") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") quote = c;
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/**
 * Index of the bracket closing the one at `open` (`(`, `[` or `{`), skipping
 * strings, raw strings and runes; -1 when it never closes.
 */
export function matchingClose(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote !== "`") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas at bracket depth 0 (strings skipped). */
export function splitGoTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote !== "`") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Net `{`/`(`/`[` depth change across `line`, strings skipped. */
export function bracketDelta(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote !== "`") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`" || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return depth;
}

/**
 * The simple name of a named type as a DI container sees it — `*pkg.PgRepo`
 * → `PgRepo`, `Repo[T]` → `Repo`. Null for anything that is not one named
 * type (a slice, map, func, channel, literal struct).
 */
export function goSimpleTypeName(raw: string): string | null {
  const t = raw.trim().replace(/^\*+\s*/, "").replace(/\[.*\]$/s, "").trim();
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(t)) return null;
  const name = t.split(".").pop()!;
  return GO_TYPE_KEYWORDS.has(name) ? null : name;
}

/** Keywords that open a type literal rather than name a type. */
export const GO_TYPE_KEYWORDS: ReadonlySet<string> = new Set(["struct", "interface", "map", "func", "chan"]);

/**
 * A function signature's result types, one entry per result, as written:
 * `*PgRepo` → [`*PgRepo`]; `(*PgRepo, error)` → [`*PgRepo`, `error`];
 * named results `(repo *PgRepo, err error)` → [`*PgRepo`, `error`]. `text` is
 * whatever follows the parameter list's closing paren, up to the body.
 */
export function goResultTypes(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (!t.startsWith("(")) return [t];
  const close = matchingClose(t, 0);
  if (close < 0) return [];
  const parts = splitGoTopLevel(t.slice(1, close));
  const named = parts.some((p) => /^[A-Za-z_]\w*\s+\S/.test(p) && !/^(?:chan|func|map|struct|interface)\b/.test(p));
  if (!named) return parts;
  // `(a, b int, err error)`: a bare name shares the type that follows it.
  const types: string[] = new Array(parts.length).fill("");
  let pending = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^[A-Za-z_]\w*\s+(.+)$/s.exec(parts[i]!);
    if (m) pending = m[1]!.trim();
    types[i] = pending;
  }
  return types;
}

/**
 * Where the result list of the func whose parameter list opens at `open`
 * ends: the index of the body's `{` (or the text's end for a body-less
 * declaration), and the result text before it. A `{` inside a result type
 * (`interface{}`, `struct{ … }`) belongs to the type.
 */
export function goResultTextAt(code: string, open: number): { text: string; bodyOpen: number } | null {
  const close = matchingClose(code, open);
  if (close < 0) return null;
  let depth = 0;
  for (let i = close + 1; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "{" && depth === 0) {
      if (/\b(?:interface|struct)\s*$/.test(code.slice(close + 1, i))) {
        const end = matchingClose(code, i);
        if (end < 0) return null;
        i = end;
        continue;
      }
      return { text: code.slice(close + 1, i), bodyOpen: i };
    } else if (c === "\n" && depth === 0) {
      return { text: code.slice(close + 1, i), bodyOpen: -1 };
    }
  }
  return { text: code.slice(close + 1), bodyOpen: -1 };
}

/**
 * The signature of the func whose parameter list opens at `open` in `code`:
 * its result types and the span of its `{ … }` body. Null when it has no
 * body that closes.
 */
export function goSignatureAt(code: string, open: number): { results: string[]; bodyStart: number; bodyEnd: number } | null {
  const head = goResultTextAt(code, open);
  if (!head || head.bodyOpen < 0) return null;
  const bodyEnd = matchingClose(code, head.bodyOpen);
  if (bodyEnd < 0) return null;
  return { results: goResultTypes(head.text), bodyStart: head.bodyOpen + 1, bodyEnd };
}
