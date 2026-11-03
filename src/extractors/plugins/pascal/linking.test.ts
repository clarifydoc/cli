/**
 * Pascal units analyzed from source and linked: what a form's event handler
 * reaches through the units it `uses`.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeUnits(units: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "pascal-link-"));
  const out = await mkdtemp(join(tmpdir(), "pascal-link-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(units)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "pascal" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** Links made from `file`, as `caller: callName -> file::symbol (strategy)`. */
async function linksFrom(units: Record<string, string>, file: string): Promise<string[]> {
  return buildSymbolLinks(await analyzeUnits(units))
    .filter((l) => l.sourceFile === file && l.relation !== "reference")
    .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}::${l.targetSymbol} (${l.strategy})`)
    .sort();
}

const LEAGUE_DATA = `unit LeagueData;
interface
uses SysUtils, Classes, DB, ADODB;
type
  TdmLeague = class(TDataModule)
    qryClubs: TADOQuery;
  public
    procedure SaveClub;
    procedure DeleteClub(Id: Integer);
  end;
var
  dmLeague: TdmLeague;
implementation
procedure TdmLeague.SaveClub;
begin
  qryClubs.SQL.Text := 'INSERT INTO clubs (name) VALUES (:name)';
  qryClubs.ExecSQL;
end;
procedure TdmLeague.DeleteClub(Id: Integer);
begin
  qryClubs.ExecSQL;
end;
end.
`;

/** A namesake: another class whose methods are called the same. */
const GARAGE = `unit Garage;
interface
type
  TCar = class
  public
    procedure SaveClub;
    procedure DeleteClub(Id: Integer);
    procedure Wash;
  end;
  TVan = class
  public
    procedure Wash;
  end;
implementation
var
  gCar: TCar;
procedure TCar.SaveClub; begin end;
procedure TCar.DeleteClub(Id: Integer); begin end;
procedure TCar.Wash; begin end;
procedure TVan.Wash; begin end;
procedure WashAll;
begin
  gCar.Wash;
end;
end.
`;

describe("Pascal unit-level variables", () => {
  it("types a call through a datamodule variable another unit declares, beside a namesake", async () => {
    const form = `unit MainForm;
interface
uses Forms, LeagueData, Garage;
type
  TfrmMain = class(TForm)
    procedure btnSaveClick(Sender: TObject);
    procedure btnDeleteClick(Sender: TObject);
  end;
implementation
procedure TfrmMain.btnSaveClick(Sender: TObject);
begin
  dmLeague.SaveClub;
end;
procedure TfrmMain.btnDeleteClick(Sender: TObject);
begin
  DMLEAGUE.DeleteClub(3);
end;
end.
`;
    expect(await linksFrom({ "LeagueData.pas": LEAGUE_DATA, "Garage.pas": GARAGE, "MainForm.pas": form }, "MainForm.pas")).toEqual([
      "TfrmMain.btnDeleteClick: DMLEAGUE.DeleteClub -> LeagueData.pas::TdmLeague.DeleteClub (injection)",
      "TfrmMain.btnSaveClick: dmLeague.SaveClub -> LeagueData.pas::TdmLeague.SaveClub (injection)",
    ]);
  });

  it("keeps an implementation-section variable to its own unit's routines", async () => {
    const coach = `unit Coach;
interface
uses Garage;
procedure Drill;
implementation
procedure Drill;
begin
  gCar.Wash;
end;
end.
`;
    const units = { "Garage.pas": GARAGE, "Coach.pas": coach };
    expect(await linksFrom(units, "Garage.pas")).toEqual(["WashAll: gCar.Wash -> Garage.pas::TCar.Wash (injection)"]);
    expect(await linksFrom(units, "Coach.pas")).toEqual([]);
  });

  it("decides nothing when two used units type the name differently, and a field of the class comes first", async () => {
    const vans = `unit Vans;
interface
uses Garage;
var
  dmLeague: TVan;
implementation
end.
`;
    const form = `unit MainForm;
interface
uses LeagueData, Vans, Garage;
type
  TfrmMain = class
  private
    FCar: TCar;
    procedure btnSaveClick(Sender: TObject);
  end;
  TfrmPit = class
  private
    dmLeague: TCar;
    procedure btnSaveClick(Sender: TObject);
  end;
implementation
procedure TfrmMain.btnSaveClick(Sender: TObject);
begin
  dmLeague.SaveClub;
end;
procedure TfrmPit.btnSaveClick(Sender: TObject);
begin
  dmLeague.SaveClub;
end;
end.
`;
    expect(await linksFrom({ "LeagueData.pas": LEAGUE_DATA, "Garage.pas": GARAGE, "Vans.pas": vans, "MainForm.pas": form }, "MainForm.pas")).toEqual([
      "TfrmPit.btnSaveClick: dmLeague.SaveClub -> Garage.pas::TCar.SaveClub (injection)",
    ]);
  });
});
