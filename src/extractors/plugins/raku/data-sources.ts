import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Raku data access the spec reads (strings intact, heredoc bodies blanked):
 * HTTP clients with a literal URL — `Cro::HTTP::Client.get('https://…')`, a
 * client built with a `base-uri` then `$client.post('/orders')`,
 * `HTTP::UserAgent.new.get(…)`, `HTTP::Tiny.new.get(…)`. SQL is read from
 * the raw source (`extractRakuSqlSources`).
 */
export function extractRakuDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, url: string, line: number) => {
    const target = url.replace(/\{\s*\$?([\w-]+)[^}]*\}|\$([\w-]+)/g, (_m, a: string, b: string) => `{${a ?? b}}`);
    if (target.startsWith("/") || /^https?:\/\//.test(target)) out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line });
  };
  const bases = new Map<string, string>();
  for (const line of lines) {
    const m = /my\s+\$([\w-]+)\s*=\s*Cro::HTTP::Client\.new\s*\(?.*?base-uri\s*=>\s*['"]([^'"]+)['"]/.exec(line);
    if (m) bases.set(m[1]!, m[2]!.replace(/\/+$/, ""));
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s#.*$/, "");
    for (const m of line.matchAll(/(?:Cro::HTTP::Client|HTTP::UserAgent(?:\.new)?|HTTP::Tiny(?:\.new)?)\.(get|post|put|patch|delete|head)\s*\(\s*(['"])(.*?)\2/g)) push(m[1]!.toUpperCase(), m[3]!, i + 1);
    for (const m of line.matchAll(/\$([\w-]+)\.(get|post|put|patch|delete|head)\s*\(\s*(['"])(\/.*?)\3/g)) {
      const base = bases.get(m[1]!);
      if (base) push(m[2]!.toUpperCase(), base + m[4]!, i + 1);
    }
  }
  return out;
}

/** [opener index, terminator index] of each heredoc (`q:to/END/`, `qq:to<SQL>`, `q:heredoc/X/`). */
function heredocSpans(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\bq{1,2}(?::\w+)*:(?:to|heredoc)[/<({]([A-Za-z_]\w*)[/>)}]/.exec(lines[i]!);
    if (!m) continue;
    const term = new RegExp(String.raw`^\s*${m[1]}\s*$`);
    let j = i + 1;
    while (j < lines.length && !term.test(lines[j]!)) j++;
    if (j < lines.length) { spans.push([i, j]); i = j; }
  }
  return spans;
}

/**
 * The source with heredoc bodies and Pod blocks (`=begin pod` … `=end pod`,
 * `=for`/`=head` paragraphs) blanked — line structure kept — so SQL or prose
 * is never read as code. Null when there is neither.
 */
export function blankRakuProse(source: string): string | null {
  if (!/\bq{1,2}(?::\w+)*:(?:to|heredoc)|^=\w/m.test(source)) return null;
  const lines = source.split("\n");
  for (const [start, end] of heredocSpans(lines)) for (let i = start + 1; i < end; i++) lines[i] = "";
  let pod: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (pod) {
      if (new RegExp(String.raw`^=end\s+${pod}\b`).test(line)) pod = null;
      lines[i] = "";
      continue;
    }
    const begin = /^=begin\s+(\w+)/.exec(line);
    if (begin) { pod = begin[1]!; lines[i] = ""; continue; }
    if (/^=\w/.test(line)) {
      // An abbreviated / paragraph block runs to the next blank line.
      for (; i < lines.length && lines[i]!.trim() !== ""; i++) lines[i] = "";
    }
  }
  return lines.join("\n");
}

/**
 * SQL statements in the RAW source: single- and double-quoted strings
 * (`$dbh.execute('SELECT …')`) and heredocs, a heredoc's body folded onto the
 * line that opens it (`$dbh.prepare(q:to/SQL/)`).
 */
export function extractRakuSqlSources(rawLines: string[]): DataSourceInfo[] {
  const lines = rawLines.map((l) =>
    l.replace(/'((?:[^'\\]|\\.)*)'/g, (all, body: string) => (/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(body) ? `"${body.replace(/"/g, '\\"')}"` : all)),
  );
  for (const [start, end] of heredocSpans(rawLines)) {
    if (!isSqlHeredoc(rawLines, start, end)) continue;
    const body = rawLines.slice(start + 1, end).map((l) => l.trim()).join(" ").replace(/"/g, "'");
    lines[start] = `${lines[start]} "${body}"`;
    for (let i = start + 1; i <= end; i++) lines[i] = "";
  }
  return extractSqlStringDataSources(lines);
}

/**
 * A heredoc is read as SQL when its terminator says so (`SQL`, `QUERY`) or its
 * body opens with a statement — usage text and templates (`END_USAGE`) are
 * prose whose words (`update`) only look like SQL.
 */
function isSqlHeredoc(lines: string[], start: number, end: number): boolean {
  const term = lines[end]!.trim();
  if (/SQL|QUERY|STMT/i.test(term)) return true;
  const first = lines.slice(start + 1, end).find((l) => l.trim())?.trim() ?? "";
  return /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CREATE|ALTER|DROP|REPLACE|UPSERT)\b/i.test(first);
}
