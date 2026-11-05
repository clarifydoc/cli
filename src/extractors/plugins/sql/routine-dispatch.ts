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
    const packageMembers = new Set<Routine>();
    for (const a of analyses) {
      if (a.language !== "sql") continue;
      for (const fn of a.functions) {
        if (fn.name === "<setup>") continue;
        const r: Routine = { file: a.filePath, projectId: a.projectId ?? "root", fn, symbol: fn.name };
        const name = fn.name.toLowerCase();
        (byName.get(name) ?? byName.set(name, []).get(name)!).push(r);
        const bare = bareOf(name);
        (byBare.get(bare) ?? byBare.set(bare, []).get(bare)!).push(r);
      }
      // A package body's subprograms are reached as `package.routine`, never by the bare routine name.
      for (const cls of a.classes) {
        if (!cls.decorators.includes("package-body")) continue;
        for (const fn of cls.methods) {
          const symbol = `${cls.name}.${fn.name}`;
          const r: Routine = { file: a.filePath, projectId: a.projectId ?? "root", fn, symbol };
          const name = symbol.toLowerCase();
          (byName.get(name) ?? byName.set(name, []).get(name)!).push(r);
          packageMembers.add(r);
        }
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
        const exact = pick(byName.get(written), project) ?? pick(byName.get(lastTwo(written)), project);
        const target = exact ?? pick(byBare.get(bareOf(written)), project);
        if (!target) continue;
        const caller = enclosing(a, ds.line);
        if (!caller) continue;
        if (caller.symbol === target.symbol && a.filePath === target.file) continue;
        const key = `${a.filePath}\0${caller.symbol}\0${target.file}\0${target.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          sourceFile: a.filePath,
          sourceSymbol: caller.symbol,
          sourceLine: ds.line,
          callName: ds.target,
          targetFile: target.file,
          targetSymbol: target.symbol,
          targetLine: target.fn.line,
          resolvedBy: "text",
          confidence: exact ? "EXTRACTED" : "INFERRED",
          relation: "dispatch",
        });
      }
    }
    // A call in a SQL routine of `FEE_PKG.Bill_Club(…)`: the package's subprogram whatever the case it is spelled in
    // (identifiers fold), when the call names exactly one.
    if (packageMembers.size > 0) {
      for (const a of analyses) {
        if (a.language !== "sql") continue;
        const project = a.projectId ?? "root";
        const callers: Array<{ symbol: string; fn: FunctionInfo }> = [
          ...a.functions.filter((f) => f.name !== "<setup>").map((f) => ({ symbol: f.name, fn: f })),
          ...a.classes.flatMap((c) => c.methods.map((m) => ({ symbol: `${c.name}.${m.name}`, fn: m }))),
        ];
        for (const { symbol, fn } of callers) {
          for (const call of fn.calls) {
            if (!call.name.includes(".")) continue;
            const target = pick(byName.get(lastTwo(call.name.replace(/[[\]"`]/g, "").toLowerCase())), project);
            if (!target || !packageMembers.has(target) || (symbol === target.symbol && a.filePath === target.file)) continue;
            const key = `${a.filePath}\0${symbol}\0${target.file}\0${target.symbol}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({
              sourceFile: a.filePath,
              sourceSymbol: symbol,
              sourceLine: call.line,
              callName: call.name,
              targetFile: target.file,
              targetSymbol: target.symbol,
              targetLine: target.fn.line,
              resolvedBy: "text",
              confidence: "EXTRACTED",
              relation: "dispatch",
            });
          }
        }
      }
    }
    return links;
  }
}

interface Routine {
  file: string;
  projectId: string;
  fn: FunctionInfo;
  /** The name the symbol linker knows it by: the routine's, or `package.routine`. */
  symbol: string;
}

/** `app.fee_pkg.bill_club` → `fee_pkg.bill_club`. */
const lastTwo = (name: string): string => name.split(".").slice(-2).join(".");

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
