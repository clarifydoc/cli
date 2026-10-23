import { describe, it, expect } from "vitest";
import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import { StoredRoutineResolver } from "./routine-dispatch.js";

const fn = (name: string, line: number, endLine: number): FunctionInfo =>
  ({ name, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line, endLine }) as FunctionInfo;

const routine = (target: string, line: number): DataSourceInfo => ({ kind: "database", name: "EXEC", target, routine: true, calls: [], line });

const file = (filePath: string, language: string, functions: FunctionInfo[], dataSources: DataSourceInfo[] = [], classes: ClassInfo[] = [], projectId = "root"): FileAnalysis =>
  ({ filePath, language, functions, classes, dataSources, imports: [], exports: [], projectId }) as unknown as FileAnalysis;

const links = (analyses: FileAnalysis[]) =>
  new StoredRoutineResolver().resolve(analyses).map((l) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol} ${l.confidence}`);

describe("a stored routine called by name reaches the routine a script declares", () => {
  const procs = file("db/procs.sql", "sql", [fn("dbo.usp_SignPlayer", 1, 9), fn("dbo.usp_NotifyAgent", 11, 12)], [routine("dbo.usp_NotifyAgent", 7)]);
  const controller = file("Api/PlayersController.cs", "csharp", [], [routine("dbo.usp_SignPlayer", 18), routine("usp_NotifyAgent", 29)], [
    { name: "PlayersController", methods: [fn("Sign", 14, 22), fn("Agent", 25, 31)], properties: [], decorators: [], implements: [], extends: null, isExported: true, line: 9, endLine: 40 } as unknown as ClassInfo,
  ]);

  it("links the method holding the call, by the name as written or by its bare name", () => {
    expect(links([procs, controller])).toEqual([
      "db/procs.sql::dbo.usp_SignPlayer -> db/procs.sql::dbo.usp_NotifyAgent EXTRACTED",
      "Api/PlayersController.cs::PlayersController.Sign -> db/procs.sql::dbo.usp_SignPlayer EXTRACTED",
      "Api/PlayersController.cs::PlayersController.Agent -> db/procs.sql::dbo.usp_NotifyAgent INFERRED",
    ]);
  });

  it("decides nothing between two routines of one bare name, unless one is the caller's sub-project's", () => {
    const twin = file("db/reports.sql", "sql", [fn("reports.usp_NotifyAgent", 1, 3)]);
    expect(links([procs, twin, controller]).filter((l) => l.includes("Agent ->"))).toEqual([]);
    const other = file("reports/procs.sql", "sql", [fn("reports.usp_NotifyAgent", 1, 3)], [], [], "reports");
    const reportsCaller = file("reports/run.py", "python", [fn("run", 1, 5)], [routine("usp_NotifyAgent", 3)], [], "reports");
    expect(links([procs, other, reportsCaller])).toContain("reports/run.py::run -> reports/procs.sql::reports.usp_NotifyAgent INFERRED");
  });
});
