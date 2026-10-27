import type { DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";

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
  return namedQueryBlocks(lines).map((b) => ({
    name: b.name,
    // Its `:name` placeholders, in order: what the loaded function is called with by keyword.
    params: b.params.map((name) => ({ name, type: null, defaultValue: null })),
    returnType: null,
    isAsync: false,
    isExported: true,
    decorators: [`${NAMED_QUERY_DECORATOR}("${b.name}")`],
    calls: [],
    line: b.line,
    endLine: b.endLine,
  }));
}

interface NamedQueryBlock {
  name: string;
  line: number;
  endLine: number;
  params: string[];
}

/** A `:name` placeholder — not a `::type` cast, not a `"…:x"` string's text. */
const PLACEHOLDER = /(?<![:\w]):([A-Za-z_]\w*)\b/g;

function namedQueryBlocks(lines: readonly string[]): NamedQueryBlock[] {
  const heads: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!);
    if (m) heads.push({ name: (m[1] ?? m[3])!, line: i + 1 });
  }
  return heads.map((h, i) => {
    let end = (heads[i + 1]?.line ?? lines.length + 1) - 1;
    while (end > h.line && !lines[end - 1]!.trim()) end--;
    const params: string[] = [];
    for (let l = h.line; l < end; l++) {
      for (const m of codeOf(lines[l]!).matchAll(PLACEHOLDER)) if (!params.includes(m[1]!)) params.push(m[1]!);
    }
    return { name: h.name, line: h.line, endLine: end, params };
  });
}

/** A line without its `--` comment and the text of its string literals (a `':x'` is no placeholder). */
const codeOf = (line: string): string => line.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, "");

/** The keywords that open a clause: a comparison is a filter when the last one before it, at its depth, is WHERE or ON. */
const CLAUSE = /\b(WHERE|ON|SET|VALUES|SELECT|RETURNING|GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|HAVING|USING)\b/gi;
/** A table a query reads or writes, and the alias it gives it. */
const TABLE_REF = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:\w+\.)?\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;
const NOT_ALIAS = /^(?:WHERE|ON|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|SET|GROUP|ORDER|WITH|UNION|USING|VALUES|LIMIT|AS|SELECT|RETURNING|AND|OR)$/i;

/**
 * The fields each named query's statements filter on with one of its
 * placeholders (`WHERE slug = :slug`, `ON … AND (a.slug = :slug)`,
 * `:id = id`, `IN (:ids)`) — never an UPDATE's SET or an INSERT's VALUES —
 * set as `whereFields` on the block's row for the table compared: the alias's
 * (`a.slug`), else the one the query at that depth reads (`FROM clubs WHERE id
 * = :id`, a subquery's own). Its parameter is the placeholder's.
 */
export function addNamedQueryFilters(lines: readonly string[], sources: DataSourceInfo[]): void {
  for (const b of namedQueryBlocks(lines)) {
    if (b.params.length === 0) continue;
    const rows = sources.filter((d) => d.kind === "database" && d.line > b.line && d.line <= b.endLine);
    if (rows.length === 0) continue;
    const starts: number[] = [];
    let text = "";
    for (let l = b.line; l < b.endLine; l++) {
      starts.push(text.length);
      text += codeOf(lines[l]!) + "\n";
    }
    const lineAt = (pos: number): number => {
      let i = 0;
      while (i + 1 < starts.length && starts[i + 1]! <= pos) i++;
      return b.line + 1 + i;
    };
    const depthAt: number[] = new Array(text.length + 1);
    let depth = 0;
    for (let i = 0; i <= text.length; i++) {
      depthAt[i] = depth;
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    const clauses = [...text.matchAll(CLAUSE)].map((m) => ({ at: m.index!, word: m[1]!.toUpperCase(), depth: depthAt[m.index!]! }));
    const aliases = new Map<string, string>();
    const tables: Array<{ at: number; table: string; depth: number }> = [];
    for (const m of text.matchAll(TABLE_REF)) {
      const table = m[1]!.split(".").pop()!;
      tables.push({ at: m.index!, table, depth: depthAt[m.index!]! });
      if (m[2] && !NOT_ALIAS.test(m[2])) aliases.set(m[2].toLowerCase(), table);
    }
    const leaf = (t: string | null | undefined) => (t ?? "").split(".").pop()!.toLowerCase();
    const add = (pos: number, qualifier: string | undefined, field: string, param: string): void => {
      const index = b.params.indexOf(param);
      if (index < 0) return;
      // A parenthesized comparison (`AND (a.slug = :slug)`) sits one deeper than its clause.
      let d = depthAt[pos]!;
      let clause = [...clauses].reverse().find((c) => c.at < pos && c.depth === d);
      while (!clause && d > 0) clause = [...clauses].reverse().find((c) => c.at < pos && c.depth === --d);
      if (!clause || (clause.word !== "WHERE" && clause.word !== "ON")) return;
      const table = qualifier ? aliases.get(qualifier.toLowerCase()) ?? qualifier : [...tables].reverse().find((t) => t.at < pos && t.depth === d)?.table;
      if (!table) return;
      const line = lineAt(pos);
      const named = rows.filter((r) => leaf(r.target) === table.toLowerCase());
      const row = named.filter((r) => r.line <= line).sort((x, y) => y.line - x.line)[0] ?? named[0];
      if (!row) return;
      const list = (row.whereFields ??= []);
      if (!list.some((w) => w.field === field && w.origin.kind === "param" && w.origin.name === param)) list.push({ field, origin: { kind: "param", name: param, index } });
    };
    for (const m of text.matchAll(/(?:\b(\w+)\.)?\b([A-Za-z_]\w*)\s*(?:=|\bIN\s*\()\s*:([A-Za-z_]\w*)\b/gi)) {
      if (!/^(?:AND|OR|NOT|WHERE|ON|IN)$/i.test(m[2]!)) add(m.index!, m[1], m[2]!, m[3]!);
    }
    for (const m of text.matchAll(/(?<![:\w]):([A-Za-z_]\w*)\s*=\s*(?:(\w+)\.)?([A-Za-z_]\w*)\b/g)) add(m.index!, m[2], m[3]!, m[1]!);
  }
}
