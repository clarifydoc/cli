/**
 * Line splitting for every line-oriented extractor.
 *
 * Why this exists: JavaScript's `.` matches any character except a line
 * terminator, and `\r` IS a line terminator. So a rule shaped
 * `/^\s*sub\s+(\w+)\s*:(.+)$/` — a capture group followed by `$` — cannot
 * match a line that still carries its `\r`. Splitting a CRLF file on `"\n"`
 * leaves that `\r` on every line, and each such rule silently stops matching:
 * the file parses, the output looks well-formed, and the facts are simply
 * missing. That is how a Windows/autocrlf checkout lost every Catalyst route
 * in the Perl fixture while reporting no error.
 *
 * End-anchored rules are common across the regex plugins, so the fix belongs
 * at the split, not in each rule. A leaf module (no plugin/registry imports)
 * so `src/core` can use it without loading a plugin, like complexity-defaults.
 */

/**
 * Split source into lines, dropping the carriage return of CRLF and CR-only
 * files. Line COUNT is unchanged versus splitting on `"\n"` for LF input, so
 * every 1-based line number downstream stays the same.
 */
export function splitLines(sourceText: string): string[] {
  return sourceText.split(/\r\n|\r|\n/);
}

/**
 * True when the text uses CR anywhere as a line terminator. Only useful for
 * diagnostics — extractors should just call `splitLines`.
 */
export function hasCarriageReturns(sourceText: string): boolean {
  return sourceText.includes("\r");
}
