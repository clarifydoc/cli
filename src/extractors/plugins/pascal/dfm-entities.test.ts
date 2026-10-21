import { describe, it, expect } from "vitest";
import { parseDfm } from "../../../parsers/dfm-parser.js";
import { DfmEntityExtractor } from "./dfm-entities.js";
import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";

/** The table entities a parsed .dfm produced, by name. */
function tablesOf(analysis: FileAnalysis): Map<string, ClassInfo> {
  const out = new Map<string, ClassInfo>();
  for (const c of analysis.classes) {
    if (c.decorators.includes("dfm")) out.set(c.name, c);
  }
  return out;
}

/** Column name → type for a table entity. */
function columnsOf(cls: ClassInfo): Record<string, string | null> {
  return Object.fromEntries(cls.properties.map((p) => [p.name, p.type]));
}

describe("DFM table extraction", () => {
  it("builds a table from single-table DML and types it from persistent fields", () => {
    // The usual FIBPlus form shape: a TpFIBDataSet whose SelectSQL is a
    // join but whose Update/Insert/Delete SQL is single-table.
    const dfm = `object frmPlayers: TfrmPlayers
  Caption = 'Players'
  object dsPlayerInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE PLAYER SET'
      '    SHIRT_NAME = :SHIRT_NAME,'
      '    AGENT_ID = :AGENT_ID,'
      '   SCOUT_NOTES =:SCOUT_NOTES'
      'WHERE'
      '    ID = :ID')
    DeleteSQL.Strings = (
      'DELETE FROM PLAYER WHERE ID = :ID')
    InsertSQL.Strings = (
      'INSERT INTO PLAYER ('
      '    ID,'
      '    SHIRT_NAME,'
      '    AGENT_ID,'
      '    SCOUT_NOTES'
      ') VALUES ('
      '    :ID, :SHIRT_NAME, :AGENT_ID, :SCOUT_NOTES'
      ')')
    SelectSQL.Strings = (
      'SELECT P.ID, P.SHIRT_NAME, C.CLUB_NAME'
      'FROM PLAYER P'
      'INNER JOIN TCLUB C ON C.ID = P.CLUB_ID')
    object dsPlayerInfoID: TIntegerField
      FieldName = 'ID'
    end
    object dsPlayerInfoSHIRT_NAME: TStringField
      FieldName = 'SHIRT_NAME'
      Size = 10
    end
    object dsPlayerInfoAGENT_ID: TIntegerField
      FieldName = 'AGENT_ID'
    end
    object dsPlayerInfoSCOUT_NOTES: TMemoField
      FieldName = 'SCOUT_NOTES'
    end
    object dsPlayerInfoCLUB_NAME: TStringField
      FieldName = 'CLUB_NAME'
      Size = 50
    end
  end
end`;
    const analysis = parseDfm(dfm, "Players.dfm");
    const tables = tablesOf(analysis);

    expect([...tables.keys()]).toEqual(["PLAYER"]);
    expect(columnsOf(tables.get("PLAYER")!)).toEqual({
      ID: "integer",
      SHIRT_NAME: "varchar(10)",
      AGENT_ID: "integer",
      SCOUT_NOTES: "text",
    });
  });

  it("does not attribute a join's borrowed columns to the owning table", () => {
    // CLUB_NAME belongs to TCLUB, not PLAYER — it reaches the dataset only
    // through the join, so it must not become a PLAYER column.
    const dfm = `object frmPlayers: TfrmPlayers
  object dsPlayerInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE PLAYER SET SHIRT_NAME = :SHIRT_NAME WHERE ID = :ID')
    SelectSQL.Strings = (
      'SELECT P.SHIRT_NAME, C.CLUB_NAME FROM PLAYER P'
      'INNER JOIN TCLUB C ON C.ID = P.CLUB_ID')
    object f1: TStringField
      FieldName = 'CLUB_NAME'
      Size = 50
    end
  end
end`;
    const player = tablesOf(parseDfm(dfm, "f.dfm")).get("PLAYER")!;
    expect(Object.keys(columnsOf(player))).toEqual(["SHIRT_NAME"]);
  });

  it("takes columns from a single-table SELECT with no DML", () => {
    // A data module's lookup datasets: read-only, one table, no DML.
    const dfm = `object DM: TDM
  object dsStadium: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    STADIUM_CODE,'
      '    STADIUM_NAME'
      'FROM'
      '    TSTADIUM '
      'ORDER BY STADIUM_CODE')
    object dsStadiumSTADIUM_CODE: TStringField
      FieldName = 'STADIUM_CODE'
      Size = 4
    end
    object dsStadiumSTADIUM_NAME: TStringField
      FieldName = 'STADIUM_NAME'
      Size = 100
    end
  end
end`;
    const tables = tablesOf(parseDfm(dfm, "DataModule.dfm"));
    expect(columnsOf(tables.get("TSTADIUM")!)).toEqual({
      STADIUM_CODE: "varchar(4)",
      STADIUM_NAME: "varchar(100)",
    });
  });

  it("skips expressions in a select list, keeping only real columns", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    ID,'
      '    SHORT_NAME,'
      '    SHORT_NAME || '#39' '#39' || LONG_NAME as Label,'
      '    COALESCE(CLUB_ID, 0) as Club'
      'FROM TPOSITION')
  end
end`;
    const position = tablesOf(parseDfm(dfm, "f.dfm")).get("TPOSITION")!;
    expect(Object.keys(columnsOf(position))).toEqual(["ID", "SHORT_NAME"]);
  });

  it("derives a many-to-one relation from a join predicate", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT T.NAME FROM TEAM_PLAYER TP'
      'INNER JOIN TEAM T ON T.ID = TP.TEAM_ID')
  end
end`;
    const analysis = parseDfm(dfm, "f.dfm");
    expect(analysis.entityRelations).toEqual([
      {
        fromEntity: "TEAM_PLAYER",
        fromField: "TEAM_ID",
        toEntity: "TEAM",
        cardinality: "many-to-one",
        foreignKey: "TEAM_ID",
        orm: "ci-query",
        confidence: "INFERRED",
      },
    ]);
  });

  it("orients the relation from the FK side regardless of predicate order", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM TCLUB C LEFT JOIN PLAYER P ON P.CLUB_ID = C.ID')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ fromEntity: "PLAYER", toEntity: "TCLUB", foreignKey: "CLUB_ID" });
  });

  it("ignores self-joins and unresolvable aliases", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM PLAYER A JOIN PLAYER B ON B.ID = A.MENTOR_ID'
      'JOIN SOMETHING X ON ZZ.ID = X.OTHER_ID')
  end
end`;
    expect(parseDfm(dfm, "f.dfm").entityRelations).toBeUndefined();
  });

  it("types columns from vendor field classes (FIBPlus, IBX, FireDAC)", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAME, FOUNDED FROM TCLUB')
    object qID: TFIBIntegerField
      FieldName = 'ID'
    end
    object qNAME: TFIBStringField
      FieldName = 'NAME'
      Size = 60
    end
    object qFOUNDED: TFDDateTimeField
      FieldName = 'FOUNDED'
    end
  end
end`;
    expect(columnsOf(tablesOf(parseDfm(dfm, "f.dfm")).get("TCLUB")!)).toEqual({
      ID: "integer",
      NAME: "varchar(60)",
      FOUNDED: "timestamp",
    });
  });

  it("does not treat a Firebird selectable stored procedure as a table", () => {
    // Firebird forms call these constantly: `FROM SP_FIXTURES(:CLUB_ID, :MATCH_DATE)`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT HOME_TEAM, AWAY_TEAM'
      'FROM SP_FIXTURES('
      '  :CLUB_ID,'
      '  :MATCH_DATE)')
  end
end`;
    expect(tablesOf(parseDfm(dfm, "f.dfm")).size).toBe(0);
  });

  it("reads OnX = Handler as an event, never a property that starts with On", () => {
    const dfm = `object F: TF
  object grid: TcxGrid
    OneOnRow = True
    OnClick = gridClick
  end
end`;
    const events = parseDfm(dfm, "f.dfm").interactiveElements?.map((e) => e.event) ?? [];
    expect(events).toEqual(["OnClick"]);
  });

  it("joins a string split across lines with + without inserting a space", () => {
    // Delphi wraps long SQL lines as `'…P1.STADIUM_' +` / `'CODE …'`. Splitting
    // mid-identifier must not produce `P1.STADIUM_ CODE`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM PLAYER P1' +
      '  LEFT JOIN TSTADIUM P1_ST ON P1_ST.STADIUM_CODE = P1.STADIUM_' +
      'CODE')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "PLAYER",
      toEntity: "TSTADIUM",
      foreignKey: "STADIUM_CODE",
    });
  });

  it("produces nothing for a form with no SQL", () => {
    const dfm = `object Form1: TForm1
  Caption = 'Hello'
  object btnOk: TButton
    Caption = 'OK'
    OnClick = btnOkClick
  end
end`;
    const analysis = parseDfm(dfm, "Form1.dfm");
    expect(tablesOf(analysis).size).toBe(0);
    expect(analysis.entityRelations).toBeUndefined();
  });

  it("emits no table for an in-memory dataset with fields but no SQL", () => {
    // TJvMemoryData grids: persistent fields describe a report shape,
    // not a physical table.
    const dfm = `object frmStandings: TfrmStandings
  object dsStandings: TJvMemoryData
    FieldDefs = <>
    object dsStandingsTEAM_NAME: TStringField
      FieldName = 'TEAM_NAME'
      Size = 50
    end
  end
end`;
    expect(tablesOf(parseDfm(dfm, "Standings.dfm")).size).toBe(0);
  });

  it("reads a TTable's TableName", () => {
    const dfm = `object DM: TDM
  object tblSponsors: TTable
    TableName = 'SPONSORS'
    object tblSponsorsNAME: TStringField
      FieldName = 'NAME'
      Size = 60
    end
  end
end`;
    const sponsors = tablesOf(parseDfm(dfm, "f.dfm")).get("SPONSORS")!;
    expect(columnsOf(sponsors)).toEqual({ NAME: "varchar(60)" });
  });
});

describe("cross-file table merge", () => {
  it("collapses a table declared on several forms into one node", () => {
    const formA = `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, SHIRT_NAME FROM PLAYER')
    object f1: TStringField
      FieldName = 'SHIRT_NAME'
      Size = 10
    end
  end
end`;
    const formB = `object B: TB
  object q: TpFIBDataSet
    UpdateSQL.Strings = ('UPDATE PLAYER SET AGENT_EMAIL = :AGENT_EMAIL WHERE ID = :ID')
    InsertSQL.Strings = ('INSERT INTO PLAYER (ID, AGENT_EMAIL, ACTIVE) VALUES (:ID, :E, :A)')
    object f1: TStringField
      FieldName = 'AGENT_EMAIL'
      Size = 80
    end
    object f2: TSmallintField
      FieldName = 'ACTIVE'
    end
  end
end`;
    const analyses = [parseDfm(formA, "a.dfm"), parseDfm(formB, "b.dfm")];
    new DfmEntityExtractor().reconcileProject(analyses);

    const declarations = analyses.flatMap((a) =>
      a.classes.filter((c) => c.name === "PLAYER").map((c) => ({ file: a.filePath, cls: c })),
    );
    expect(declarations).toHaveLength(1);
    // b.dfm knows 3 columns to a.dfm's 2, so it wins and absorbs SHIRT_NAME.
    expect(declarations[0]!.file).toBe("b.dfm");
    expect(columnsOf(declarations[0]!.cls)).toEqual({
      ID: null,
      AGENT_EMAIL: "varchar(80)",
      ACTIVE: "smallint",
      SHIRT_NAME: "varchar(10)",
    });
  });

  it("takes the dropped duplicate's type references with it", () => {
    const form = (name: string, sql: string) => `object ${name}: T${name}
  object q: TpFIBDataSet
    InsertSQL.Strings = ('${sql}')
    object f1: TStringField
      FieldName = 'NAME'
      Size = 30
    end
  end
end`;
    const analyses = [
      parseDfm(form("A", "INSERT INTO PLAYER (ID, NAME) VALUES (:ID, :NAME)"), "a.dfm"),
      parseDfm(form("B", "INSERT INTO PLAYER (ID) VALUES (:ID)"), "b.dfm"),
    ];
    // File analysis derives a "field" reference per typed column AFTER the
    // entity lands in `classes` (type-reference-extractor.ts) — mirror that.
    for (const a of analyses) {
      a.typeReferences = a.classes.flatMap((c) =>
        c.properties.filter((p) => p.type).map((p) => ({
          rawType: p.type!,
          typeName: p.type!,
          usageKind: "field" as const,
          sourceFile: a.filePath,
          sourceLine: c.line,
          sourceSymbol: `${c.name}.${p.name}`,
          sourceClass: c.name,
        })),
      );
    }
    new DfmEntityExtractor().reconcileProject(analyses);

    // b.dfm lost its PLAYER node, so nothing in b.dfm may still reference PLAYER
    // as a containing class — buildClassGraph would resurrect the node from it.
    const loser = analyses.find((a) => !a.classes.some((c) => c.name === "PLAYER"))!;
    expect(loser.typeReferences?.some((r) => r.sourceClass === "PLAYER")).toBe(false);
    const winner = analyses.find((a) => a !== loser)!;
    expect(winner.typeReferences?.some((r) => r.sourceClass === "PLAYER")).toBe(true);
  });

  it("leaves a table declared in only one file alone", () => {
    const analyses = [
      parseDfm(
        `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAME FROM TNATION')
  end
end`,
        "a.dfm",
      ),
    ];
    const before = analyses[0]!.classes.length;
    new DfmEntityExtractor().reconcileProject(analyses);
    expect(analyses[0]!.classes.length).toBe(before);
  });
});

describe("DFM reconcile — a dataset passed to a routine", () => {
  const unit = (filePath: string, functions: unknown[], dataSources: unknown[]): FileAnalysis =>
    ({ filePath, language: "pascal", functions, classes: [], dataSources } as unknown as FileAnalysis);
  const fn = (name: string, line: number, endLine: number, params: string[], calls: unknown[] = []) =>
    ({ name, line, endLine, params: params.map((p) => ({ name: p, type: "TDataSet" })), calls });

  it("names the table the callers' component reads, only when every caller agrees", () => {
    const form = parseDfm(`object F: TF
  object qrySquad: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAME FROM TSQUAD')
  end
  object memCopy: TRxMemoryData
  end
end`, "Squad.dfm");
    const helper = unit("Helper.pas", [fn("FillGrid", 10, 20, ["ADataSet"]), fn("Print", 30, 40, ["ADataSet"])], [
      { kind: "database", name: "ADataSet.FieldByName", target: "ADataSet", calls: [], line: 12 },
      { kind: "database", name: "ADataSet.FieldByName", target: "ADataSet", calls: [], line: 32 },
    ]);
    const caller = unit("Squad.pas", [
      fn("TF.Show", 1, 8, [], [
        { name: "FillGrid", kind: "cross-file", target: null, line: 3, args: ["qrySquad"] },
        { name: "Print", kind: "cross-file", target: null, line: 4, args: ["qrySquad"] },
        { name: "Print", kind: "cross-file", target: null, line: 5, args: ["memCopy"] },
      ]),
    ], []);
    new DfmEntityExtractor().reconcileProject([form, helper, caller]);
    // FillGrid only ever reads qrySquad's table; Print also reads an in-memory copy, so it is left alone.
    expect(helper.dataSources.map((d) => d.entity ?? null)).toEqual(["TSQUAD", null]);
  });
});

describe("DFM reconcile — a unit's dataset calls join the form's SQL", () => {
  const unit = (filePath: string, dataSources: unknown[]): FileAnalysis =>
    ({ filePath, language: "pascal", functions: [], classes: [], dataSources } as unknown as FileAnalysis);

  it("names the component's own table, never a joined one, and a procedure as a routine", () => {
    const form = parseDfm(`object F: TF
  object dsTeams: TpFIBDataSet
    SelectSQL.Strings = ('SELECT T.ID FROM TEAM T INNER JOIN LEAGUE L ON L.ID = T.LEAGUE_ID')
  end
  object dsStandings: TpFIBDataSet
    SelectSQL.Strings = ('SELECT * FROM SP_STANDINGS(:SEASON) S INNER JOIN TEAM T ON T.ID = S.TEAM_ID')
  end
end`, "Teams.dfm");
    const code = unit("Teams.pas", [
      { kind: "database", name: "dsTeams.Open", target: "dsTeams", calls: [], line: 10 },
      { kind: "database", name: "dsStandings.Open", target: "dsStandings", calls: [], line: 11 },
    ]);
    new DfmEntityExtractor().reconcileProject([form, code]);
    expect(code.dataSources.map((d) => [d.target, d.entity ?? null, d.routine ?? false])).toEqual([
      ["dsTeams", "TEAM", false],
      ["SP_STANDINGS", null, true],
    ]);
  });
});
