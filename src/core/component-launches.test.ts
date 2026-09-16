import { describe, it, expect } from "vitest";
import { buildFormLaunches } from "./component-launches.js";
import { createEmptyAnalysis, type FileAnalysis, type FunctionInfo } from "../types/analysis.js";

/** A .dfm as the parser reports it: root class + root instance variable. */
function form(path: string, cls: string, instance: string): FileAnalysis {
  const a = createEmptyAnalysis(path, "dfm");
  a.classes = [{
    name: cls, extends: null, implements: [], decorators: [], methods: [],
    properties: [], isExported: true, line: 1, endLine: 1,
  }];
  a.exports = [{ name: instance, kind: "variable", line: 1 }];
  return a;
}

function routine(name: string, calls: { name: string; line: number }[]): FunctionInfo {
  return {
    name, params: [], returnType: null, isAsync: false, isExported: true,
    decorators: [], line: 1, endLine: 2,
    calls: calls.map((c) => ({ name: c.name, kind: "internal" as const, target: null, line: c.line, column: 0 })),
  };
}

/** A .pas unit whose form class declares the given methods. */
function unit(path: string, cls: string, methods: FunctionInfo[]): FileAnalysis {
  const a = createEmptyAnalysis(path, "pascal");
  a.classes = [{
    name: cls, extends: null, implements: [], decorators: [], methods,
    properties: [], isExported: true, line: 1, endLine: 99,
  }];
  return a;
}

describe("Delphi form launches", () => {
  const dialog = form("t2UFRelationsAttributer.dfm", "TfrmRelationer", "frmRelationer");
  const waitForm = form("WaitForm.dfm", "TWaitForm", "frmWait");

  it("links a form to the form it constructs", () => {
    const caller = unit("FamilyFrame.pas", "TfrFamilie", [
      routine("btnRedigerClick", [{ name: "TfrmRelationer.Create", line: 187 }]),
    ]);
    const out = buildFormLaunches([dialog, waitForm, form("FamilyFrame.dfm", "TfrFamilie", "frFamilie"), caller]);
    expect(out).toEqual([{
      // reported .dfm → .dfm so it lands on both screens
      sourceFile: "FamilyFrame.dfm",
      sourceSymbol: "btnRedigerClick",
      targetFile: "t2UFRelationsAttributer.dfm",
      launcher: "btnRedigerClick",
      line: 187,
    }]);
  });

  it("links a global form instance opened with Show/ShowModal", () => {
    const caller = unit("Main.pas", "TfrmMain", [routine("Busy", [{ name: "frmWait.Show", line: 55 }])]);
    const out = buildFormLaunches([waitForm, form("Main.dfm", "TfrmMain", "frmMain"), caller]);
    expect(out.map((l) => [l.sourceFile, l.targetFile])).toEqual([["Main.dfm", "WaitForm.dfm"]]);
  });

  it("ignores constructors of classes that are not forms", () => {
    // These outnumber real form constructions in a Delphi codebase.
    const caller = unit("Report.pas", "TfrmReport", [
      routine("Run", [
        { name: "TpFIBQuery.Create", line: 10 },
        { name: "TFileStream.Create", line: 11 },
        { name: "TStringList.Create", line: 12 },
      ]),
    ]);
    expect(buildFormLaunches([dialog, caller])).toEqual([]);
  });

  it("reports a launcher in a unit with no form of its own against that unit", () => {
    const a = createEmptyAnalysis("DialogHelpers.pas", "pascal");
    a.functions = [routine("ShowRelationer", [{ name: "TfrmRelationer.Create", line: 46 }])];
    const out = buildFormLaunches([dialog, a]);
    expect(out[0]).toMatchObject({ sourceFile: "DialogHelpers.pas", targetFile: "t2UFRelationsAttributer.dfm" });
  });

  it("skips the synthetic unit-level symbol, which duplicates the real routine", () => {
    const a = createEmptyAnalysis("u.pas", "pascal");
    a.functions = [
      routine("<setup>", [{ name: "TfrmRelationer.Create", line: 46 }]),
      routine("ShowRelationer", [{ name: "TfrmRelationer.Create", line: 46 }]),
    ];
    expect(buildFormLaunches([dialog, a]).map((l) => l.launcher)).toEqual(["ShowRelationer"]);
  });

  it("drops a class name declared by two different forms rather than guessing", () => {
    const dupA = form("a.dfm", "TfrmDup", "frmDupA");
    const dupB = form("b.dfm", "TfrmDup", "frmDupB");
    const caller = unit("c.pas", "TfrmC", [routine("Go", [{ name: "TfrmDup.Create", line: 5 }])]);
    expect(buildFormLaunches([dupA, dupB, caller])).toEqual([]);
  });

  it("never links a form to itself", () => {
    const self = unit("WaitForm.pas", "TWaitForm", [routine("Go", [{ name: "TWaitForm.Create", line: 5 }])]);
    expect(buildFormLaunches([waitForm, self])).toEqual([]);
  });

  it("credits the CALLERS of a dialog-opener that builds its own form", () => {
    // `ShowPupilsWindow` lives in the unit whose form it opens, so the edge on
    // its own unit is a self-link; the screens that navigate are its callers.
    const opener = createEmptyAnalysis("T2UFPupils.pas", "pascal");
    opener.functions = [routine("ShowPupilsWindow", [{ name: "TfrmPupils.Create", line: 90 }])];
    const pupils = form("T2UFPupils.dfm", "TfrmPupils", "frmPupils");
    const links = [{
      sourceFile: "Main.pas", sourceSymbol: "TfrmMain.mnuPupilsClick", sourceLine: 412,
      callName: "ShowPupilsWindow", targetFile: "T2UFPupils.pas", targetSymbol: "ShowPupilsWindow",
      targetLine: 90, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([pupils, form("Main.dfm", "TfrmMain", "frmMain"), opener], links);
    expect(out).toEqual([{
      sourceFile: "Main.dfm",
      sourceSymbol: "TfrmMain.mnuPupilsClick",
      targetFile: "T2UFPupils.dfm",
      launcher: "ShowPupilsWindow",
      line: 412,
    }]);
  });

  it("reports the launcher when the caller resolved to the unit-level bucket", () => {
    const opener = createEmptyAnalysis("t2ufGL_DriverRatings.pas", "pascal");
    opener.functions = [routine("ShowDriverRatings", [{ name: "TfrmKar.Create", line: 20 }])];
    const kar = form("t2ufGL_DriverRatings.dfm", "TfrmKar", "frmKar");
    const links = [{
      sourceFile: "t2ufHold.pas", sourceSymbol: "<setup>", sourceLine: 88,
      callName: "ShowDriverRatings", targetFile: "t2ufGL_DriverRatings.pas",
      targetSymbol: "ShowDriverRatings", targetLine: 20, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([kar, form("t2ufHold.dfm", "TfrmHold", "frmHold"), opener], links);
    // The edge survives (it is the only evidence of this navigation) …
    expect(out).toHaveLength(1);
    // … but never surfaces the placeholder symbol.
    expect(out[0]!.sourceSymbol).toBe("ShowDriverRatings");
  });

  it("attributes a generically-named opener only to callers the linker resolved", () => {
    // Many classes have an `Execute`; name matching alone would over-connect.
    const opener = createEmptyAnalysis("t2ufVaelgPlanTypes.pas", "pascal");
    opener.functions = [routine("Execute", [{ name: "TfrmAbon.Create", line: 30 }])];
    const abon = form("t2ufVaelgPlanTypes.dfm", "TfrmAbon", "frmAbon");
    const links = [{
      sourceFile: "Real.pas", sourceSymbol: "TfrmReal.Go", sourceLine: 7,
      callName: "Execute", targetFile: "t2ufVaelgPlanTypes.pas", targetSymbol: "Execute",
      targetLine: 30, confidence: "EXTRACTED" as const,
    }, {
      // An unrelated Execute in another unit — must not produce an edge.
      sourceFile: "Other.pas", sourceSymbol: "TfrmOther.Go", sourceLine: 9,
      callName: "Execute", targetFile: "SomeThread.pas", targetSymbol: "TWorker.Execute",
      targetLine: 12, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([abon, form("Real.dfm", "TfrmReal", "f1"), form("Other.dfm", "TfrmOther", "f2"), opener], links);
    expect(out.map((l) => l.sourceFile)).toEqual(["Real.dfm"]);
  });

  it("returns nothing for a project with no forms", () => {
    expect(buildFormLaunches([createEmptyAnalysis("a.ts", "typescript")])).toEqual([]);
  });
});
