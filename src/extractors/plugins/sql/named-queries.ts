import type { FunctionInfo } from "../../../types/analysis.js";

/**
 * Named queries: a `.sql` file of statements each headed by a name comment,
 * which a library loads and exposes as functions —
 *
 *     -- name: get-article-by-slug^         aiosql (Python), dotsql / goyesql (Go)
 *     -- :name find-user :? :1              HugSQL (Clojure), PugSQL (Python)
 *     -- name: GetAuthor :one               sqlc (Go)
 *     mergedBucket:                         Drift (Dart, a `.drift` file)
 *
 * Each becomes a function named as written, without aiosql's operator suffix
 * (`!`, `^`, `$`, `<!`, `*!`, `#`), spanning its statement up to the next
 * header — so the statement's table accesses, which the data-source pass
 * already reads line by line, belong to it. Decorated `@named-query("…")`
 * with the header's name as written. How a call names one (aiosql's
 * `queries.get_article_by_slug`) is the calling language's resolver's business.
 */

const HEADER = /^\s*--\s*(?:name\s*:\s*|:name\s+)([A-Za-z_][\w-]*)([!^$#*<>]*)|^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*$/;

export const NAMED_QUERY_DECORATOR = "@named-query";

export function namedQueries(lines: readonly string[]): FunctionInfo[] {
  const heads: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    if (m) heads.push({ name: (m[1] ?? m[3])!, line: i + 1 });
  }
  return heads.map((h, i) => {
    let end = (heads[i + 1]?.line ?? lines.length + 1) - 1;
    while (end > h.line && !lines[end - 1]!.trim()) end--;
    return {
      name: h.name,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: true,
      decorators: [`${NAMED_QUERY_DECORATOR}("${h.name}")`],
      calls: [],
      line: h.line,
      endLine: end,
    };
  });
}
