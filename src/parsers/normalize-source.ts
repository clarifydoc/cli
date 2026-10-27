/**
 * The text a front end parses: lines as `splitLines` counts them (ANTLR and tree-sitter count only `\n`, and a
 * CR-only file would read as one line), without a byte-order mark, which is no token of any grammar. Token
 * offsets and columns index this text.
 */
export function normalizeSource(source: string): string {
  return source.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}
