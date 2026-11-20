/**
 * A heredoc is read as SQL when its terminator says so (`SQL`, `QUERY`) or its
 * body opens with a statement — usage text and templates (`END_USAGE`) are
 * prose whose words (`update`) only look like SQL.
 */
export function isSqlHeredoc(lines: string[], start: number, end: number): boolean {
  const term = lines[end]!.trim();
  if (/SQL|QUERY|STMT/i.test(term)) return true;
  const first = lines.slice(start + 1, end).find((l) => l.trim())?.trim() ?? "";
  return /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CREATE|ALTER|DROP|REPLACE|UPSERT)\b/i.test(first);
}
