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
import { applyModuleSearchPaths } from "../../../core/module-search-paths.js";
import type { FileAnalysis, SubProject } from "../../../types/analysis.js";

/** Analyzes the units (`.pas`/`.dpr`); other files (`.dproj`, `.lpi`) are only written, then read as build files. */
async function analyzeUnits(units: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "pascal-link-"));
  const out = await mkdtemp(join(tmpdir(), "pascal-link-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(units)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
    if (!/\.(?:pas|dpr)$/.test(rel)) continue;
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
  await applyModuleSearchPaths(analyses, root, [{ id: "root", root: "" } as SubProject]);
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

/** A car whose members are read without parentheses, and a van with the same method names. */
const CARS = `unit Cars;
interface
type
  TCar = class
  private
    FSpeed: Integer;
    function GetPoints: Integer;
  public
    Gloss: Integer;
    procedure Wash;
    function Shine: Integer;
    property Points: Integer read GetPoints;
    property Speed: Integer read FSpeed;
  end;
  TVan = class
  public
    function Shine: Integer;
    function IsEmpty: Boolean;
    function GetPoints: Integer;
  end;
implementation
function TCar.GetPoints: Integer; begin Result := 3; end;
procedure TCar.Wash; begin end;
function TCar.Shine: Integer; begin Result := 1; end;
function TVan.Shine: Integer; begin Result := 2; end;
function TVan.IsEmpty: Boolean; begin Result := True; end;
function TVan.GetPoints: Integer; begin Result := 4; end;
end.
`;

const COACH = `unit Coach;
interface
uses Cars, ADODB;
type
  TCoach = class
  private
    FCar: TCar;
    FTotal: Integer;
    function GetTotal: Integer;
  public
    procedure Drill(ACar: TCar);
    procedure Rest; virtual;
    procedure Report;
    property Total: Integer read GetTotal;
  end;
  THeadCoach = class(TCoach)
  public
    constructor Create(AOwner: TObject);
    procedure Rest; override;
    procedure Drill2;
  end;
implementation
function TCoach.GetTotal: Integer; begin Result := FTotal; end;
procedure TCoach.Rest; begin end;
procedure TCoach.Report; begin end;
procedure TCoach.Drill(ACar: TCar);
var
  N: Integer;
  qryClubs: TADOQuery;
begin
  N := ACar.Shine;
  N := N + FCar.Shine;
  if ACar.Points > 2 then N := 0;
  N := N + ACar.Speed + ACar.Gloss;
  N := N + Total;
  while not qryClubs.IsEmpty do N := N - 1;
  OnDone := Report;
end;
constructor THeadCoach.Create(AOwner: TObject);
begin
  inherited Create(AOwner);
end;
procedure THeadCoach.Rest;
begin
  inherited;
end;
procedure THeadCoach.Drill2;
begin
  inherited Rest;
end;
end.
`;

describe("Pascal names read without parentheses", () => {
  it("reaches a method or a property's accessor through the receiver's type, never a field", async () => {
    expect(await linksFrom({ "Cars.pas": CARS, "Coach.pas": COACH }, "Coach.pas")).toEqual([
      "TCoach.Drill: ACar.Points -> Cars.pas::TCar.GetPoints (injection)",
      "TCoach.Drill: ACar.Shine -> Cars.pas::TCar.Shine (injection)",
      "TCoach.Drill: FCar.Shine -> Cars.pas::TCar.Shine (injection)",
      "TCoach.Drill: Report -> Coach.pas::TCoach.Report (direct)",
      "TCoach.Drill: Total -> Coach.pas::TCoach.GetTotal (direct)",
      "THeadCoach.Drill2: super.Rest -> Coach.pas::TCoach.Rest (inheritance)",
      "THeadCoach.Rest: super -> Coach.pas::TCoach.Rest (inheritance)",
    ]);
  });

  it("hands a procedure on rather than calling it, and never reads a name as a database call", async () => {
    const analyses = await analyzeUnits({ "Cars.pas": CARS, "Coach.pas": COACH });
    const relation = buildSymbolLinks(analyses).find((l) => l.callName === "Report")?.relation;
    expect(relation).toBe("passes");
    const drill = analyses.find((a) => a.filePath === "Coach.pas")!.classes.find((c) => c.name === "TCoach")!.methods.find((m) => m.name === "Drill")!;
    expect(drill.calls.filter((c) => c.read).map((c) => `${c.name} ${c.kind}`).sort()).toEqual([
      "ACar.Gloss internal", "ACar.Points internal", "ACar.Shine internal", "ACar.Speed internal",
      "FCar.Shine internal", "Report internal", "Total internal", "qryClubs.IsEmpty internal",
    ]);
  });
});

/** The same unit in two platform folders. Left to its name alone, `uses Garage` lands on the Posix one. */
const PLATFORM_GARAGE = (platform: string) => `unit Garage;
interface
type
  TCar = class
  public
    procedure Wash;
  end;
implementation
procedure TCar.Wash; begin { ${platform} } end;
end.
`;

const FLEET = `unit Fleet;
interface
uses Garage;
type
  TFleet = class
  private
    FCar: TCar;
  public
    procedure Clean(ACar: TCar);
  end;
implementation
procedure TFleet.Clean(ACar: TCar);
begin
  ACar.Wash;
  FCar.Wash;
end;
end.
`;

const dproj = (body: string) => `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <MainSource>League.dpr</MainSource>
  </PropertyGroup>
${body}
</Project>
`;

const program = (uses: string) => `program League;
uses
  Forms,
  ${uses}
  Fleet in 'Fleet.pas';
begin
  Application.Run;
end.
`;

describe("Pascal routines handed on by name", () => {
  it("passes a routine that needs arguments or whose address is taken, and calls one that needs none", async () => {
    const table = `unit Table;
interface
uses Classes;
procedure Rank(L: TList);
implementation
function CompareClubs(A, B: Pointer): Integer; begin Result := 0; end;
function LeagueSize: Integer; begin Result := 20; end;
function Promoted(Club: Pointer): Boolean; begin Result := False; end;
procedure Rank(L: TList);
var N: Integer;
begin
  L.Sort(CompareClubs);
  ForEachClub(@Promoted);
  N := LeagueSize;
end;
end.
`;
    const links = buildSymbolLinks(await analyzeUnits({ "Table.pas": table }))
      .filter((l) => l.sourceSymbol === "Rank")
      .map((l) => `${l.callName} -> ${l.targetSymbol} ${l.relation}`)
      .sort();
    expect(links).toEqual(["CompareClubs -> CompareClubs passes", "LeagueSize -> LeagueSize calls", "Promoted -> Promoted passes"]);
  });
});

describe("Pascal property accessors along a class hierarchy", () => {
  it("reads an inherited property through the accessor the reading class overrides", async () => {
    const squads = `unit Squads;
interface
type
  TSquad = class
  protected
    function GetCount: Integer; virtual;
  public
    property Count: Integer read GetCount;
  end;
  TBench = class(TSquad)
  protected
    function GetCount: Integer; override;
  public
    procedure Trim;
  end;
  TStand = class(TSquad)
  private
    function GetRow(Index: Integer): Integer;
  public
    property FrontRow: Integer index 1 read GetRow;
    procedure Fill(ABench: TBench);
  end;
implementation
function TSquad.GetCount: Integer; begin Result := 0; end;
function TBench.GetCount: Integer; begin Result := 1; end;
procedure TBench.Trim;
var I: Integer;
begin
  for I := 0 to Count - 1 do ;
end;
function TStand.GetRow(Index: Integer): Integer; begin Result := Index; end;
procedure TStand.Fill(ABench: TBench);
var I: Integer;
begin
  I := Count + ABench.Count + FrontRow;
end;
end.
`;
    expect(await linksFrom({ "Squads.pas": squads }, "Squads.pas")).toEqual([
      "TBench.Trim: Count -> Squads.pas::TBench.GetCount (direct)",
      "TStand.Fill: ABench.Count -> Squads.pas::TBench.GetCount (injection)",
      "TStand.Fill: Count -> Squads.pas::TSquad.GetCount (inheritance)",
      // An indexed property's accessor takes the index the property states: still a call.
      "TStand.Fill: FrontRow -> Squads.pas::TStand.GetRow (direct)",
    ].sort());
    const frontRow = buildSymbolLinks(await analyzeUnits({ "Squads.pas": squads })).find((l) => l.callName === "FrontRow");
    expect(frontRow?.relation).toBe("calls");
  });
});

describe("Pascal unit search paths", () => {
  const units = (extra: Record<string, string>) => ({
    "Win/Garage.pas": PLATFORM_GARAGE("Win"),
    "Posix/Garage.pas": PLATFORM_GARAGE("Posix"),
    "Fleet.pas": FLEET,
    ...extra,
  });
  const targets = (extra: Record<string, string>) => linksFrom(units(extra), "Fleet.pas");
  // A parameter's and a field's type alike.
  const washes = (dir: string) => [
    `TFleet.Clean: ACar.Wash -> ${dir}/Garage.pas::TCar.Wash (injection)`,
    `TFleet.Clean: FCar.Wash -> ${dir}/Garage.pas::TCar.Wash (injection)`,
  ];

  it("takes the folder a .dproj's unit search path names", async () => {
    const project = dproj(`  <PropertyGroup Condition="'$(Base)'!=''">
    <DCC_UnitSearchPath>Win;$(DCC_UnitSearchPath)</DCC_UnitSearchPath>
  </PropertyGroup>`);
    expect(await targets({ "League.dproj": project, "League.dpr": program("") })).toEqual(washes("Win"));
  });

  it("refuses to pick between the directories of platform-conditioned groups by their order", async () => {
    const both = dproj(`  <PropertyGroup Condition="'$(Platform)'=='Win32'">
    <DCC_UnitSearchPath>Win</DCC_UnitSearchPath>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Platform)'=='Linux64'">
    <DCC_UnitSearchPath>Posix</DCC_UnitSearchPath>
  </PropertyGroup>`);
    // The order the platforms are listed in decides nothing: the unit is neither, so no link names either.
    const swapped = dproj(`  <PropertyGroup Condition="'$(Platform)'=='Linux64'">
    <DCC_UnitSearchPath>Posix</DCC_UnitSearchPath>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Platform)'=='Win32'">
    <DCC_UnitSearchPath>Win</DCC_UnitSearchPath>
  </PropertyGroup>`);
    // Without any build file the generic rules still pick one.
    expect(await targets({})).toEqual(washes("Posix"));
    expect(await targets({ "League.dproj": both, "League.dpr": program("") })).toEqual([]);
    expect(await targets({ "League.dproj": swapped, "League.dpr": program("") })).toEqual([]);
    // A group every build reads still decides, and so does the one directory a platform group leaves.
    const general = dproj(`  <PropertyGroup>
    <DCC_UnitSearchPath>Win</DCC_UnitSearchPath>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Platform)'=='Linux64'">
    <DCC_UnitSearchPath>Posix</DCC_UnitSearchPath>
  </PropertyGroup>`);
    expect(await targets({ "League.dproj": general, "League.dpr": program("") })).toEqual(washes("Win"));
    const only = dproj(`  <PropertyGroup Condition="'$(Platform)'=='Win32'">
    <DCC_UnitSearchPath>Win</DCC_UnitSearchPath>
  </PropertyGroup>`);
    expect(await targets({ "League.dproj": only, "League.dpr": program("") })).toEqual(washes("Win"));
  });

  it("takes the file a program's `uses … in` or a .dproj unit reference names, before the search path", async () => {
    const project = dproj(`  <PropertyGroup>
    <DCC_UnitSearchPath>Posix</DCC_UnitSearchPath>
  </PropertyGroup>`);
    expect(await targets({ "League.dproj": project, "League.dpr": program("Garage in 'Win\\Garage.pas',") })).toEqual(washes("Win"));
    const referenced = dproj(`  <ItemGroup>
    <DCCReference Include="win\\garage.pas"/>
  </ItemGroup>`);
    expect(await targets({ "League.dproj": referenced, "League.dpr": program("") })).toEqual(washes("Win"));
  });

  it("takes a Lazarus project's other unit files", async () => {
    const lpi = `<?xml version="1.0" encoding="UTF-8"?>
<CONFIG>
  <CompilerOptions>
    <SearchPaths>
      <OtherUnitFiles Value="win;$(LazarusDir)/lcl"/>
    </SearchPaths>
  </CompilerOptions>
</CONFIG>
`;
    expect(await targets({ "League.lpi": lpi })).toEqual(washes("Win"));
  });
});

describe("Pascal with statements", () => {
  const CLUBS = `unit Clubs;
interface
type
  TClub = class
    procedure Save;
  end;
implementation
procedure TClub.Save;
begin
end;
end.
`;
  const DECOY = `unit Decoy;
interface
type
  TCar = class
    procedure Save;
  end;
implementation
procedure TCar.Save;
begin
end;
end.
`;
  const main = (body: string) => `unit Main;
interface
uses Clubs, Decoy;
procedure Run;
implementation
var Home: TClub;
procedure Run;
var Club: TClub; Car: TCar; Mystery: TUnknown;
begin
${body}
end;
end.
`;
  const links = (body: string) => linksFrom({ "Clubs.pas": CLUBS, "Decoy.pas": DECOY, "Main.pas": main(body) }, "Main.pas");

  it("links a bare call to the member of the with subject's declared type", async () => {
    expect(await links("  with Club do Save;")).toEqual(["Run: Save -> Clubs.pas::TClub.Save (injection)"]);
    expect(await links("  with Home do begin Save; end;")).toEqual(["Run: Save -> Clubs.pas::TClub.Save (injection)"]);
    // The innermost subject first: `Car` is the inner one.
    expect(await links("  with Club do with Car do Save;")).toEqual(["Run: Save -> Decoy.pas::TCar.Save (injection)"]);
  });

  it("decides nothing for a subject of unknown type, and keeps a call outside the with a plain bare call", async () => {
    expect(await links("  with Mystery do Save;")).toEqual([]);
    expect(await links("  with Club do Fill(Save);\n  Save;")).toEqual([]);
  });
});

describe("Pascal with statements: a dotted callee is looked up in the subject", () => {
  const DATA = `unit Data;
interface
type
  TClubQuery = class
    procedure Open;
  end;
  TDm = class
    Clubs: TClubQuery;
  end;
var Dm: TDm;
implementation
procedure TClubQuery.Open;
begin
end;
end.
`;
  const DECOY = `unit Decoy;
interface
type
  TCars = class
    procedure Open;
  end;
var Clubs: TCars;
implementation
procedure TCars.Open;
begin
end;
end.
`;
  const main = (body: string) => `unit Main;
interface
uses Data, Decoy;
procedure Run;
implementation
procedure Run;
begin
${body}
end;
end.
`;
  const links = (body: string) => linksFrom({ "Data.pas": DATA, "Decoy.pas": DECOY, "Main.pas": main(body) }, "Main.pas");

  it("links `Clubs.Open` inside `with Dm do` through the subject's field, not the namesake variable", async () => {
    expect(await links("  with Dm do Clubs.Open;")).toEqual(["Run: Clubs.Open -> Data.pas::TClubQuery.Open (injection)"]);
  });

  it("keeps a dotted call outside any with as it was", async () => {
    expect(await links("  Clubs.Open;")).toEqual(["Run: Clubs.Open -> Decoy.pas::TCars.Open (injection)"]);
  });
});
