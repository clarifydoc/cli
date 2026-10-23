import type { FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * A stored procedure or function called by name reaches the routine a SQL
 * script declares with that name:
 *
 *     Api/PlayersController.cs   new SqlCommand("dbo.usp_SignPlayer", conn) { CommandType = StoredProcedure }
 *     Db/procs.sql               CREATE PROCEDURE [dbo].[usp_SignPlayer] … UPDATE dbo.Players …
 *
 * The call site is a `routine` data source (any language that recognises one:
 * ADO.NET and Dapper commands, JDBC `{call x}`, `cursor.callproc`, a SQL
 * `EXEC x` or `FROM fn(…)`). This adds the hop from the function holding it
 * to the routine, so a trace goes on to the tables the routine reads and
 * writes. The name as written, schema and all, decides when exactly one
 * routine carries it (EXTRACTED); a name written without the schema the
 * script gives it (`usp_SignPlayer` → `dbo.usp_SignPlayer`), or with one the
 * script leaves out, decides only when one routine of that bare name exists
 * (INFERRED). Several candidates decide nothing; the caller's own sub-project
 * is preferred first.
 */
export class StoredRoutineResolver implements DispatchResolver {
  readonly id = "sql-routine";
  readonly languages: Language[] = [
    "sql", "csharp", "vb", "fsharp", "java", "kotlin", "scala", "groovy", "springxml", "python", "php", "ruby", "perl",
    "javascript", "typescript", "go", "rust", "pascal", "dfm", "c", "cpp", "objc", "dart", "elixir", "powershell",
  ];
  readonly priority = 56;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const byName = new Map<string, Routine[]>();
    const byBare = new Map<string, Routine[]>();
    for (const a of analyses) {
      if (a.language !== "sql") continue;
      for (const fn of a.functions) {
        if (fn.name === "<setup>") continue;
        const r: Routine = { file: a.filePath, projectId: a.projectId ?? "root", fn };
        const name = fn.name.toLowerCase();
        (byName.get(name) ?? byName.set(name, []).get(name)!).push(r);
        const bare = bareOf(name);
        (byBare.get(bare) ?? byBare.set(bare, []).get(bare)!).push(r);
      }
    }
    if (byName.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of analyses) {
      for (const ds of a.dataSources ?? []) {
        if (!ds.routine || !ds.target) continue;
        const written = ds.target.replace(/[[\]"`]/g, "").replace(/\s*\(.*$/, "").toLowerCase();
        const project = a.projectId ?? "root";
        const exact = pick(byName.get(written), project);
        const target = exact ?? pick(byBare.get(bareOf(written)), project);
        if (!target) continue;
        const caller = enclosing(a, ds.line);
        if (!caller) continue;
        if (caller.symbol === target.fn.name && a.filePath === target.file) continue;
        const key = `${a.filePath}\0${caller.symbol}\0${target.file}\0${target.fn.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          sourceFile: a.filePath,
          sourceSymbol: caller.symbol,
          sourceLine: ds.line,
          callName: ds.target,
          targetFile: target.file,
          targetSymbol: target.fn.name,
          targetLine: target.fn.line,
          resolvedBy: "text",
          confidence: exact ? "EXTRACTED" : "INFERRED",
          relation: "dispatch",
        });
      }
    }
    return links;
  }
}

interface Routine {
  file: string;
  projectId: string;
  fn: FunctionInfo;
}

const bareOf = (name: string): string => name.split(".").pop()!;

/** The one routine of the candidates — the caller's sub-project's first; null for none or several. */
function pick(cands: Routine[] | undefined, project: string): Routine | null {
  if (!cands?.length) return null;
  const own = cands.filter((r) => r.projectId === project);
  const pool = own.length > 0 ? own : cands;
  const distinct = new Set(pool.map((r) => `${r.file}\0${r.fn.name}`));
  return distinct.size === 1 ? pool[0]! : null;
}

/** The innermost function or method whose body holds `line`, as the symbol linker names it. */
function enclosing(a: FileAnalysis, line: number): { symbol: string } | null {
  let best: { symbol: string; span: number } | null = null;
  const consider = (symbol: string, fn: FunctionInfo): void => {
    if (line < fn.line || line > (fn.endLine ?? fn.line)) return;
    const span = (fn.endLine ?? fn.line) - fn.line;
    if (!best || span < best.span) best = { symbol, span };
  };
  for (const fn of a.functions) if (fn.name !== "<setup>") consider(fn.name, fn);
  for (const cls of a.classes) for (const m of cls.methods ?? []) consider(`${cls.name}.${m.name}`, m);
  if (best) return best;
  return a.functions.some((f) => f.name === "<setup>") ? { symbol: "<setup>" } : null;
}
