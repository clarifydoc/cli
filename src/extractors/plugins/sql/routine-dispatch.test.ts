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

describe("a package's subprograms are reached as package.routine", () => {
  const pkgClass = (name: string, methods: FunctionInfo[]): ClassInfo =>
    ({ name, methods, properties: [], decorators: ["package-body"], implements: [], extends: null, isExported: true, line: 1, endLine: 30 }) as unknown as ClassInfo;
  const feePkg = file("db/fee_pkg.pkb", "sql", [], [], [pkgClass("fee_pkg", [fn("bill_club", 3, 9)])]);
  const decoy = file("db/other_pkg.pkb", "sql", [], [], [pkgClass("other_pkg", [fn("bill_club", 3, 9)])]);

  it("links an EXEC or a client's routine call whatever the case, never by the bare routine name", () => {
    const caller = file("Api/Billing.cs", "csharp", [], [routine("FEE_PKG.BILL_CLUB", 5), routine("bill_club", 9)], [
      { name: "Billing", methods: [fn("Run", 4, 7), fn("Bare", 8, 10)], properties: [], decorators: [], implements: [], extends: null, isExported: true, line: 1, endLine: 12 } as unknown as ClassInfo,
    ]);
    expect(links([feePkg, decoy, caller])).toEqual(["Api/Billing.cs::Billing.Run -> db/fee_pkg.pkb::fee_pkg.bill_club EXTRACTED"]);
  });

  it("links a call inside a SQL routine written in another case than the package", () => {
    const close = file("db/season.sql", "sql", [{ ...fn("close_season", 1, 6), calls: [{ name: "FEE_PKG.Bill_Club", line: 3, kind: "internal" }] } as FunctionInfo]);
    expect(links([feePkg, decoy, close])).toEqual(["db/season.sql::close_season -> db/fee_pkg.pkb::fee_pkg.bill_club EXTRACTED"]);
  });
});
