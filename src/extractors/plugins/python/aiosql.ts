import type { CallInfo, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * aiosql (and PugSQL's `pugsql.module`) loads a directory of named-query
 * `.sql` files into one object whose attributes are the queries:
 *
 *     app/db/queries/queries.py      queries = aiosql.from_path(Path(__file__).parent / "sql", "asyncpg")
 *     app/db/queries/sql/articles.sql   -- name: get-article-by-slug^
 *     app/db/repositories/articles.py   await queries.get_article_by_slug(conn, slug=slug)
 *
 * The SQL plugin makes each `-- name:` block a function (named-queries.ts);
 * this adds the hop from the call to it, so a trace goes on to the table. The
 * call names the query (dashes read as underscores) on an object imported
 * from — or made in — a module whose top level calls the loader; the query is
 * the one block of that name in a `.sql` file under that module's directory.
 * Unique or nothing.
 */

const LOADER = /^(?:aiosql\.from_(?:path|str)|pugsql\.module)$/;

/** `app.db.queries.queries` → the analysed file it names (`.py` or a package `__init__.py`). */
function moduleFile(module: string, files: ReadonlySet<string>, byTail: ReadonlyMap<string, string[]>): string | null {
  const path = module.replace(/^\.+/, "").replace(/\./g, "/");
  for (const candidate of [`${path}.py`, `${path}/__init__.py`]) {
    if (files.has(candidate)) return candidate;
    const tails = byTail.get(candidate) ?? [];
    if (tails.length === 1) return tails[0]!;
  }
  return null;
}

const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/") + 1);
const queryKey = (name: string) => name.replace(/-/g, "_").toLowerCase();

export class AiosqlQueryResolver implements DispatchResolver {
  readonly id = "aiosql";
  readonly languages: Language[] = ["python", "sql"];
  readonly priority = 56;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const named = new Map<string, Array<{ file: string; name: string; line: number }>>();
    for (const a of analyses) {
      if (a.language !== "sql") continue;
      for (const fn of a.functions) {
        if (!fn.decorators.some((d) => d.startsWith("@named-query("))) continue;
        const k = queryKey(fn.name);
        (named.get(k) ?? named.set(k, []).get(k)!).push({ file: a.filePath, name: fn.name, line: fn.line });
      }
    }
    if (named.size === 0) return [];
    const loaders = new Set(
      analyses
        .filter((a) => a.language === "python" && a.functions.some((f) => f.name === "<setup>" && f.calls.some((c) => LOADER.test(c.name))))
        .map((a) => a.filePath),
    );
    if (loaders.size === 0) return [];

    const files = new Set(analyses.map((a) => a.filePath));
    const byTail = new Map<string, string[]>();
    for (const f of files) {
      if (!f.endsWith(".py")) continue;
      for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) {
        const tail = f.slice(i + 1);
        (byTail.get(tail) ?? byTail.set(tail, []).get(tail)!).push(f);
      }
    }

    const links: SymbolLink[] = [];
    const link = (a: FileAnalysis, symbol: string, call: CallInfo): void => {
      const parts = call.name.split(".");
      if (parts.length !== 2) return;
      const loader = call.kind === "cross-file" && call.target ? moduleFile(call.target, files, byTail) : loaders.has(a.filePath) ? a.filePath : null;
      if (!loader || !loaders.has(loader)) return;
      const under = dirOf(loader);
      const hits = (named.get(queryKey(parts[1]!)) ?? []).filter((q) => q.file.startsWith(under));
      if (hits.length !== 1) return;
      const q = hits[0]!;
      links.push({
        sourceFile: a.filePath,
        sourceSymbol: symbol,
        sourceLine: call.line,
        callName: call.name,
        targetFile: q.file,
        targetSymbol: q.name,
        targetLine: q.line,
        resolvedBy: "text",
        confidence: "INFERRED",
        relation: "dispatch",
      });
    };
    for (const a of analyses) {
      if (a.language !== "python") continue;
      for (const fn of a.functions) for (const c of fn.calls) link(a, fn.name, c);
      for (const cls of a.classes) for (const m of cls.methods) for (const c of m.calls) link(a, `${cls.name}.${m.name}`, c);
    }
    return links;
  }
}
