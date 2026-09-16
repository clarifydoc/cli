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
    // Shape taken from team-desk's Players.dfm: a TpFIBDataSet whose SelectSQL is a
    // join but whose Update/Insert/Delete SQL is single-table.
    const dfm = `object frmPlayers: TfrmPlayers
  Caption = 'Player'
  object dsPlayerInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE COACH SET'
      '    INITIALS = :INITIALS,'
      '    WEBUSERID = :WEBUSERID,'
      '   NOTE =:NOTE'
      'WHERE'
      '    ID = :ID')
    DeleteSQL.Strings = (
      'DELETE FROM COACH WHERE ID = :ID')
    InsertSQL.Strings = (
      'INSERT INTO COACH ('
      '    ID,'
      '    INITIALS,'
      '    WEBUSERID,'
      '    NOTE'
      ') VALUES ('
      '    :ID, :INITIALS, :WEBUSERID, :NOTE'
      ')')
    SelectSQL.Strings = (
      'SELECT L.ID, L.INITIALS, P.FIRSTNAME'
      'FROM COACH L'
      'INNER JOIN TPERSON P ON P.ID = L.PERSON_ID')
    object dsPlayerInfoID: TIntegerField
      FieldName = 'ID'
    end
    object dsPlayerInfoINITIALS: TStringField
      FieldName = 'INITIALS'
      Size = 10
    end
    object dsPlayerInfoWEBUSERID: TIntegerField
      FieldName = 'WEBUSERID'
    end
    object dsPlayerInfoNOTE: TMemoField
      FieldName = 'NOTE'
    end
    object dsPlayerInfoFIRSTNAME: TStringField
      FieldName = 'FIRSTNAME'
      Size = 50
    end
  end
end`;
    const analysis = parseDfm(dfm, "Players.dfm");
    const tables = tablesOf(analysis);

    expect([...tables.keys()]).toEqual(["COACH"]);
    expect(columnsOf(tables.get("COACH")!)).toEqual({
      ID: "integer",
      INITIALS: "varchar(10)",
      WEBUSERID: "integer",
      NOTE: "text",
    });
  });

  it("does not attribute a join's borrowed columns to the owning table", () => {
    // FIRSTNAME belongs to TPERSON, not COACH — it reaches the dataset only
    // through the join, so it must not become a COACH column.
    const dfm = `object frmPlayers: TfrmPlayers
  object dsPlayerInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE COACH SET INITIALS = :INITIALS WHERE ID = :ID')
    SelectSQL.Strings = (
      'SELECT L.INITIALS, P.FIRSTNAME FROM COACH L'
      'INNER JOIN TPERSON P ON P.ID = L.PERSON_ID')
    object f1: TStringField
      FieldName = 'FIRSTNAME'
      Size = 50
    end
  end
end`;
    const coach = tablesOf(parseDfm(dfm, "f.dfm")).get("COACH")!;
    expect(Object.keys(columnsOf(coach))).toEqual(["INITIALS"]);
  });

  it("takes columns from a single-table SELECT with no DML", () => {
    // team-desk's t2DataModule.dfm lookup datasets: read-only, one table, no DML.
    const dfm = `object DM: TDM
  object dsPostBy: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    POSTCODE,'
      '    TOWN'
      'FROM'
      '    TPOSTTOWN '
      'ORDER BY POSTCODE')
    object dsPostByPOSTCODE: TStringField
      FieldName = 'POSTCODE'
      Size = 4
    end
    object dsPostByTOWN: TStringField
      FieldName = 'TOWN'
      Size = 100
    end
  end
end`;
    const tables = tablesOf(parseDfm(dfm, "t2DataModule.dfm"));
    expect(columnsOf(tables.get("TPOSTTOWN")!)).toEqual({
      POSTCODE: "varchar(4)",
      TOWN: "varchar(100)",
    });
  });

  it("skips expressions in a select list, keeping only real columns", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    ID,'
      '    SHORT_LABEL,'
      '    SHORT_LABEL || '#39' '#39' || LANG_LABEL as Label,'
      '    COALESCE(CLUB_ID, 0) as Club'
      'FROM TSKILL')
  end
end`;
    const tfag = tablesOf(parseDfm(dfm, "f.dfm")).get("TSKILL")!;
    expect(Object.keys(columnsOf(tfag))).toEqual(["ID", "SHORT_LABEL"]);
  });

  it("derives a many-to-one relation from a join predicate", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT T.NAME FROM TEAM_PLAYER TL'
      'INNER JOIN TEAM T ON T.ID = TL.TEAM_ID')
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
      'SELECT * FROM TCLUB S LEFT JOIN COACH L ON L.CLUB_ID = S.ID')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ fromEntity: "COACH", toEntity: "TCLUB", foreignKey: "CLUB_ID" });
  });

  it("ignores self-joins and unresolvable aliases", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM TPERSON A JOIN TPERSON B ON B.ID = A.PARENT_ID'
      'JOIN SOMETHING X ON ZZ.ID = X.OTHER_ID')
  end
end`;
    expect(parseDfm(dfm, "f.dfm").entityRelations).toBeUndefined();
  });

  it("types columns from vendor field classes (FIBPlus, IBX, FireDAC)", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAME, CREATED FROM TCLUB')
    object qID: TFIBIntegerField
      FieldName = 'ID'
    end
    object qNAVN: TFIBStringField
      FieldName = 'NAME'
      Size = 60
    end
    object qCREATED: TFDDateTimeField
      FieldName = 'CREATED'
    end
  end
end`;
    expect(columnsOf(tablesOf(parseDfm(dfm, "f.dfm")).get("TCLUB")!)).toEqual({
      ID: "integer",
      NAME: "varchar(60)",
      CREATED: "timestamp",
    });
  });

  it("does not treat a Firebird selectable stored procedure as a table", () => {
    // team-desk calls these constantly: `FROM SP_WAITLIST(:CLUB_ID, :MATCH_DATE)`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT CPRNR, NAME'
      'FROM SP_WAITLIST('
      '  :CLUB_ID,'
      '  :MATCH_DATE)')
  end
end`;
    expect(tablesOf(parseDfm(dfm, "f.dfm")).size).toBe(0);
  });

  it("joins a string split across lines with + without inserting a space", () => {
    // Delphi wraps long SQL lines as `'…GARAGE1.POST' +` / `'CODE …'`. Splitting
    // mid-identifier must not produce `GARAGE1.POST CODE`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM TPERSON GARAGE1' +
      '  LEFT JOIN TPOSTTOWN GARAGE1_BY ON GARAGE1_BY.POSTCODE = GARAGE1.POST' +
      'CODE')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "TPERSON",
      toEntity: "TPOSTTOWN",
      foreignKey: "POSTCODE",
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
    // team-desk's TJvMemoryData grids: persistent fields describe a report shape,
    // not a physical table.
    const dfm = `object frmArk: TfrmArk
  object dsArk: TJvMemoryData
    FieldDefs = <>
    object dsArkCPRNR: TStringField
      FieldName = 'CPRNR'
      Size = 50
    end
  end
end`;
    expect(tablesOf(parseDfm(dfm, "Ark.dfm")).size).toBe(0);
  });

  it("reads a TTable's TableName", () => {
    const dfm = `object DM: TDM
  object tblCustomers: TTable
    TableName = 'CUSTOMERS'
    object tblCustomersNAVN: TStringField
      FieldName = 'NAME'
      Size = 60
    end
  end
end`;
    const customers = tablesOf(parseDfm(dfm, "f.dfm")).get("CUSTOMERS")!;
    expect(columnsOf(customers)).toEqual({ NAME: "varchar(60)" });
  });
});

describe("cross-file table merge", () => {
  it("collapses a table declared on several forms into one node", () => {
    const formA = `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, INITIALS FROM COACH')
    object f1: TStringField
      FieldName = 'INITIALS'
      Size = 10
    end
  end
end`;
    const formB = `object B: TB
  object q: TpFIBDataSet
    UpdateSQL.Strings = ('UPDATE COACH SET EMAIL_ARB = :EMAIL_ARB WHERE ID = :ID')
    InsertSQL.Strings = ('INSERT INTO COACH (ID, EMAIL_ARB, AKTIV) VALUES (:ID, :E, :A)')
    object f1: TStringField
      FieldName = 'EMAIL_ARB'
      Size = 80
    end
    object f2: TSmallintField
      FieldName = 'AKTIV'
    end
  end
end`;
    const analyses = [parseDfm(formA, "a.dfm"), parseDfm(formB, "b.dfm")];
    new DfmEntityExtractor().reconcileProject(analyses);

    const declarations = analyses.flatMap((a) =>
      a.classes.filter((c) => c.name === "COACH").map((c) => ({ file: a.filePath, cls: c })),
    );
    expect(declarations).toHaveLength(1);
    // b.dfm knows 3 columns to a.dfm's 2, so it wins and absorbs INITIALS.
    expect(declarations[0]!.file).toBe("b.dfm");
    expect(columnsOf(declarations[0]!.cls)).toEqual({
      ID: null,
      EMAIL_ARB: "varchar(80)",
      AKTIV: "smallint",
      INITIALS: "varchar(10)",
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
      parseDfm(form("A", "INSERT INTO COACH (ID, NAME) VALUES (:ID, :NAME)"), "a.dfm"),
      parseDfm(form("B", "INSERT INTO COACH (ID) VALUES (:ID)"), "b.dfm"),
    ];
    new DfmEntityExtractor().reconcileProject(analyses);

    // b.dfm lost its COACH node, so nothing in b.dfm may still reference COACH
    // as a containing class — buildClassGraph would resurrect the node from it.
    const loser = analyses.find((a) => !a.classes.some((c) => c.name === "COACH"))!;
    expect(loser.typeReferences?.some((r) => r.sourceClass === "COACH")).toBe(false);
    const winner = analyses.find((a) => a !== loser)!;
    expect(winner.typeReferences?.some((r) => r.sourceClass === "COACH")).toBe(true);
  });

  it("leaves a table declared in only one file alone", () => {
    const analyses = [
      parseDfm(
        `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAME FROM TCOUNTRIES')
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
