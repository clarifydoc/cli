import { describe, it, expect } from "vitest";
import { buildFormLaunches, markStartupScreens } from "./component-launches.js";
import { createEmptyAnalysis, type FileAnalysis, type FunctionInfo, type ScreenInfo } from "../types/analysis.js";

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
  const dialog = form("TransferDialog.dfm", "TfrmTransfer", "frmTransfer");
  const waitForm = form("WaitForm.dfm", "TWaitForm", "frmWait");

  it("links a form to the form it constructs", () => {
    const caller = unit("SquadFrame.pas", "TfrSquad", [
      routine("btnEditClick", [{ name: "TfrmTransfer.Create", line: 187 }]),
    ]);
    const out = buildFormLaunches([dialog, waitForm, form("SquadFrame.dfm", "TfrSquad", "frSquad"), caller]);
    expect(out).toEqual([{
      // reported .dfm → .dfm so it lands on both screens
      sourceFile: "SquadFrame.dfm",
      sourceSymbol: "btnEditClick",
      targetFile: "TransferDialog.dfm",
      launcher: "btnEditClick",
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
    a.functions = [routine("ShowTransfer", [{ name: "TfrmTransfer.Create", line: 46 }])];
    const out = buildFormLaunches([dialog, a]);
    expect(out[0]).toMatchObject({ sourceFile: "DialogHelpers.pas", targetFile: "TransferDialog.dfm" });
  });

  it("skips the synthetic unit-level symbol, which duplicates the real routine", () => {
    const a = createEmptyAnalysis("u.pas", "pascal");
    a.functions = [
      routine("<setup>", [{ name: "TfrmTransfer.Create", line: 46 }]),
      routine("ShowTransfer", [{ name: "TfrmTransfer.Create", line: 46 }]),
    ];
    expect(buildFormLaunches([dialog, a]).map((l) => l.launcher)).toEqual(["ShowTransfer"]);
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
    // `ShowPlayersWindow` lives in the unit whose form it opens, so the edge on
    // its own unit is a self-link; the screens that navigate are its callers.
    const opener = createEmptyAnalysis("Players.pas", "pascal");
    opener.functions = [routine("ShowPlayersWindow", [{ name: "TfrmPlayers.Create", line: 90 }])];
    const players = form("Players.dfm", "TfrmPlayers", "frmPlayers");
    const links = [{
      sourceFile: "Main.pas", sourceSymbol: "TfrmMain.mnuPlayersClick", sourceLine: 412,
      callName: "ShowPlayersWindow", targetFile: "Players.pas", targetSymbol: "ShowPlayersWindow",
      targetLine: 90, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([players, form("Main.dfm", "TfrmMain", "frmMain"), opener], links);
    expect(out).toEqual([{
      sourceFile: "Main.dfm",
      sourceSymbol: "TfrmMain.mnuPlayersClick",
      targetFile: "Players.dfm",
      launcher: "ShowPlayersWindow",
      line: 412,
    }]);
  });

  it("reports the launcher when the caller resolved to the unit-level bucket", () => {
    const opener = createEmptyAnalysis("PlayerRatings.pas", "pascal");
    opener.functions = [routine("ShowPlayerRatings", [{ name: "TfrmRatings.Create", line: 20 }])];
    const ratings = form("PlayerRatings.dfm", "TfrmRatings", "frmRatings");
    const links = [{
      sourceFile: "Teams.pas", sourceSymbol: "<setup>", sourceLine: 88,
      callName: "ShowPlayerRatings", targetFile: "PlayerRatings.pas",
      targetSymbol: "ShowPlayerRatings", targetLine: 20, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([ratings, form("Teams.dfm", "TfrmTeams", "frmTeams"), opener], links);
    // The edge survives (it is the only evidence of this navigation) …
    expect(out).toHaveLength(1);
    // … but never surfaces the placeholder symbol.
    expect(out[0]!.sourceSymbol).toBe("ShowPlayerRatings");
  });

  it("attributes a generically-named opener only to callers the linker resolved", () => {
    // Many classes have an `Execute`; name matching alone would over-connect.
    const opener = createEmptyAnalysis("SelectTicketTypes.pas", "pascal");
    opener.functions = [routine("Execute", [{ name: "TfrmTickets.Create", line: 30 }])];
    const tickets = form("SelectTicketTypes.dfm", "TfrmTickets", "frmTickets");
    const links = [{
      sourceFile: "Real.pas", sourceSymbol: "TfrmReal.Go", sourceLine: 7,
      callName: "Execute", targetFile: "SelectTicketTypes.pas", targetSymbol: "Execute",
      targetLine: 30, confidence: "EXTRACTED" as const,
    }, {
      // An unrelated Execute in another unit — must not produce an edge.
      sourceFile: "Other.pas", sourceSymbol: "TfrmOther.Go", sourceLine: 9,
      callName: "Execute", targetFile: "SomeThread.pas", targetSymbol: "TWorker.Execute",
      targetLine: 12, confidence: "EXTRACTED" as const,
    }];
    const out = buildFormLaunches([tickets, form("Real.dfm", "TfrmReal", "f1"), form("Other.dfm", "TfrmOther", "f2"), opener], links);
    expect(out.map((l) => l.sourceFile)).toEqual(["Real.dfm"]);
  });

  it("returns nothing for a project with no forms", () => {
    expect(buildFormLaunches([createEmptyAnalysis("a.ts", "typescript")])).toEqual([]);
  });
});

describe("Delphi startup screens", () => {
  const screen = (path: string, name: string): ScreenInfo => ({
    name, formType: name, caption: null, dimensions: null,
    components: [], filePath: path, routePath: null, navigatesTo: [],
  });

  /** A .dpr whose source is supplied through the raw-source map. */
  function project(body: string): [FileAnalysis, Map<string, string>] {
    const a = createEmptyAnalysis("League.dpr", "pascal");
    return [a, new Map([["League.dpr", body]])];
  }

  it("marks the first Application.CreateForm as the main form", () => {
    const [dpr, sources] = project(`begin
  Application.Initialize;
  Application.CreateForm(TMainForm, MainForm);
  Application.CreateForm(TFProgress, FProgress);
  Application.Run;
end.`);
    const main = screen("Main.dfm", "MainForm");
    const progress = screen("UFProgress.dfm", "FProgress");
    const analyses = [dpr, form("Main.dfm", "TMainForm", "MainForm"), form("UFProgress.dfm", "TFProgress", "FProgress")];
    markStartupScreens(analyses, [main, progress], sources);
    expect(main.startup).toBe("main");
    expect(progress.startup).toBe("auto-created");
  });

  it("leaves every other screen unmarked", () => {
    const [dpr, sources] = project("Application.CreateForm(TMainForm, MainForm);");
    const main = screen("Main.dfm", "MainForm");
    const dialog = screen("Dlg.dfm", "Dlg");
    markStartupScreens(
      [dpr, form("Main.dfm", "TMainForm", "MainForm"), form("Dlg.dfm", "TDlg", "Dlg")],
      [main, dialog],
      sources,
    );
    expect(dialog.startup).toBeUndefined();
  });

  it("does not promote a later form when a data module is created first", () => {
    // TDM has no .dfm screen; the form after it is still only auto-created.
    const [dpr, sources] = project(`Application.CreateForm(TDM, DM);
Application.CreateForm(TMainForm, MainForm);`);
    const main = screen("Main.dfm", "MainForm");
    markStartupScreens([dpr, form("Main.dfm", "TMainForm", "MainForm")], [main], sources);
    expect(main.startup).toBe("auto-created");
  });

  it("does nothing without a project file", () => {
    const main = screen("Main.dfm", "MainForm");
    markStartupScreens([form("Main.dfm", "TMainForm", "MainForm")], [main], new Map());
    expect(main.startup).toBeUndefined();
  });
});
