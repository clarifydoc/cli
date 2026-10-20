/**
 * Escaping and formatting helpers shared by every writer.
 *
 * Each target format has exactly one character class that can corrupt it, and
 * every one of them occurs in real analysis output: `|` in a call expression
 * breaks a markdown table row, `<` in a C# generic breaks GraphML, `'` in an
 * identifier breaks a Cypher literal, and `"` in a route path breaks a Mermaid
 * label. These are the only place any writer is allowed to interpolate
 * analysis-derived text.
 */

/** Markdown table cell: pipes and newlines end a row, so neither may survive. */
export function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "—";
}

/** Markdown inline code cell — the common case for paths and symbols. */
export function codeCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  // A backtick inside the value would close the span; widen the fence instead.
  const text = String(value).replace(/\r?\n/g, " ");
  const fence = text.indexOf("`") === -1 ? "`" : "``";
  // Inside a code span a backslash is literal, so only the pipes get one: the table
  // parser strips exactly the backslash it finds before a pipe, and nothing else.
  return `${fence}${text.split("|").join("\\|")}${fence}`;
}

/** `path:line`, the grep-able reference form used throughout the markdown. */
export function at(filePath: unknown, line?: unknown): string {
  if (!filePath) return "—";
  return codeCell(typeof line === "number" && line > 0 ? `${filePath}:${line}` : String(filePath));
}

/**
 * Text for a line comment (`//` in Cypher, `%%` in Mermaid).
 *
 * A comment ends at the newline, so a value that contains one — and analysis
 * output does: a route path scraped out of a template literal, a project
 * rooted at a path with a stray newline — spills the rest of the header into
 * the file as code. Collapse all whitespace and the comment stays a comment.
 */
export function commentLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function xml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * CSV field (RFC 4180): quoted when it holds a comma, quote or line break. A
 * field a spreadsheet would run as a formula (`=`, `+`, `-`, `@` first — a
 * route or symbol named by the repository can start that way) gets a leading
 * `'`, the form spreadsheets show as text; a plain number is left alone.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Cypher single-quoted string literal. */
export function cypherStr(value: unknown): string {
  return `'${String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " ")}'`;
}

// One implementation of Mermaid label escaping and id minting for every diagram the tool draws.
export { mermaidLabel, idFactory } from "../core/mermaid-text.js";

/** `n (p%)` — the audit-trail idiom. Zero total renders as a plain zero. */
export function share(n: number, total: number): string {
  if (!total) return String(n);
  return `${n} (${Math.round((n / total) * 100)}%)`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Stable "biggest first" ordering with a name tiebreak, so exports diff cleanly. */
export function byDesc<T>(value: (t: T) => number, name: (t: T) => string) {
  return (a: T, b: T): number => value(b) - value(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);
}
