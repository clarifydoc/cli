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
    // Shape taken from tea's t2ufLaerer.dfm: a TpFIBDataSet whose SelectSQL is a
    // join but whose Update/Insert/Delete SQL is single-table.
    const dfm = `object frmLaerer: TfrmLaerer
  Caption = 'Laerer'
  object dsLaererInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE LARER SET'
      '    INITIALER = :INITIALER,'
      '    WEBBRUGERID = :WEBBRUGERID,'
      '   BEMAERKNING =:BEMAERKNING'
      'WHERE'
      '    ID = :ID')
    DeleteSQL.Strings = (
      'DELETE FROM LARER WHERE ID = :ID')
    InsertSQL.Strings = (
      'INSERT INTO LARER ('
      '    ID,'
      '    INITIALER,'
      '    WEBBRUGERID,'
      '    BEMAERKNING'
      ') VALUES ('
      '    :ID, :INITIALER, :WEBBRUGERID, :BEMAERKNING'
      ')')
    SelectSQL.Strings = (
      'SELECT L.ID, L.INITIALER, P.FORNAVN'
      'FROM LARER L'
      'INNER JOIN TPERSON P ON P.ID = L.PERSON_ID')
    object dsLaererInfoID: TIntegerField
      FieldName = 'ID'
    end
    object dsLaererInfoINITIALER: TStringField
      FieldName = 'INITIALER'
      Size = 10
    end
    object dsLaererInfoWEBBRUGERID: TIntegerField
      FieldName = 'WEBBRUGERID'
    end
    object dsLaererInfoBEMAERKNING: TMemoField
      FieldName = 'BEMAERKNING'
    end
    object dsLaererInfoFORNAVN: TStringField
      FieldName = 'FORNAVN'
      Size = 50
    end
  end
end`;
    const analysis = parseDfm(dfm, "t2ufLaerer.dfm");
    const tables = tablesOf(analysis);

    expect([...tables.keys()]).toEqual(["LARER"]);
    expect(columnsOf(tables.get("LARER")!)).toEqual({
      ID: "integer",
      INITIALER: "varchar(10)",
      WEBBRUGERID: "integer",
      BEMAERKNING: "text",
    });
  });

  it("does not attribute a join's borrowed columns to the owning table", () => {
    // FORNAVN belongs to TPERSON, not LARER — it reaches the dataset only
    // through the join, so it must not become a LARER column.
    const dfm = `object frmLaerer: TfrmLaerer
  object dsLaererInfo: TpFIBDataSet
    UpdateSQL.Strings = (
      'UPDATE LARER SET INITIALER = :INITIALER WHERE ID = :ID')
    SelectSQL.Strings = (
      'SELECT L.INITIALER, P.FORNAVN FROM LARER L'
      'INNER JOIN TPERSON P ON P.ID = L.PERSON_ID')
    object f1: TStringField
      FieldName = 'FORNAVN'
      Size = 50
    end
  end
end`;
    const larer = tablesOf(parseDfm(dfm, "f.dfm")).get("LARER")!;
    expect(Object.keys(columnsOf(larer))).toEqual(["INITIALER"]);
  });

  it("takes columns from a single-table SELECT with no DML", () => {
    // tea's t2DataModule.dfm lookup datasets: read-only, one table, no DML.
    const dfm = `object DM: TDM
  object dsPostBy: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    POSTNR,'
      '    BYNAVN'
      'FROM'
      '    TPOSTBY '
      'ORDER BY POSTNR')
    object dsPostByPOSTNR: TStringField
      FieldName = 'POSTNR'
      Size = 4
    end
    object dsPostByBYNAVN: TStringField
      FieldName = 'BYNAVN'
      Size = 100
    end
  end
end`;
    const tables = tablesOf(parseDfm(dfm, "t2DataModule.dfm"));
    expect(columnsOf(tables.get("TPOSTBY")!)).toEqual({
      POSTNR: "varchar(4)",
      BYNAVN: "varchar(100)",
    });
  });

  it("skips expressions in a select list, keeping only real columns", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT'
      '    ID,'
      '    KORT_BETEGNELSE,'
      '    KORT_BETEGNELSE || '#39' '#39' || LANG_BETEGNELSE as Betegnelse,'
      '    COALESCE(SKOLE_ID, 0) as Skole'
      'FROM TFAG')
  end
end`;
    const tfag = tablesOf(parseDfm(dfm, "f.dfm")).get("TFAG")!;
    expect(Object.keys(columnsOf(tfag))).toEqual(["ID", "KORT_BETEGNELSE"]);
  });

  it("derives a many-to-one relation from a join predicate", () => {
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT T.NAVN FROM TEAM_LAERER TL'
      'INNER JOIN TEAM T ON T.ID = TL.TEAM_ID')
  end
end`;
    const analysis = parseDfm(dfm, "f.dfm");
    expect(analysis.entityRelations).toEqual([
      {
        fromEntity: "TEAM_LAERER",
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
      'SELECT * FROM TSKOLE S LEFT JOIN LARER L ON L.SKOLE_ID = S.ID')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ fromEntity: "LARER", toEntity: "TSKOLE", foreignKey: "SKOLE_ID" });
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
    SelectSQL.Strings = ('SELECT ID, NAVN, OPRETTET FROM TSKOLE')
    object qID: TFIBIntegerField
      FieldName = 'ID'
    end
    object qNAVN: TFIBStringField
      FieldName = 'NAVN'
      Size = 60
    end
    object qOPRETTET: TFDDateTimeField
      FieldName = 'OPRETTET'
    end
  end
end`;
    expect(columnsOf(tablesOf(parseDfm(dfm, "f.dfm")).get("TSKOLE")!)).toEqual({
      ID: "integer",
      NAVN: "varchar(60)",
      OPRETTET: "timestamp",
    });
  });

  it("does not treat a Firebird selectable stored procedure as a table", () => {
    // tea calls these constantly: `FROM SP_VENTELISTE(:SKOLE_ID, :DATO)`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT CPRNR, NAVN'
      'FROM SP_VENTELISTE('
      '  :SKOLE_ID,'
      '  :DATO)')
  end
end`;
    expect(tablesOf(parseDfm(dfm, "f.dfm")).size).toBe(0);
  });

  it("joins a string split across lines with + without inserting a space", () => {
    // Delphi wraps long SQL lines as `'…KONT1.POST' +` / `'NR …'`. Splitting
    // mid-identifier must not produce `KONT1.POST NR`.
    const dfm = `object DM: TDM
  object q: TpFIBDataSet
    SelectSQL.Strings = (
      'SELECT * FROM TPERSON KONT1' +
      '  LEFT JOIN TPOSTBY KONT1_BY ON KONT1_BY.POSTNR = KONT1.POST' +
      'NR')
  end
end`;
    const rels = parseDfm(dfm, "f.dfm").entityRelations!;
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({
      fromEntity: "TPERSON",
      toEntity: "TPOSTBY",
      foreignKey: "POSTNR",
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
    // tea's TJvMemoryData grids: persistent fields describe a report shape,
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
  object tblKunder: TTable
    TableName = 'KUNDER'
    object tblKunderNAVN: TStringField
      FieldName = 'NAVN'
      Size = 60
    end
  end
end`;
    const kunder = tablesOf(parseDfm(dfm, "f.dfm")).get("KUNDER")!;
    expect(columnsOf(kunder)).toEqual({ NAVN: "varchar(60)" });
  });
});

describe("cross-file table merge", () => {
  it("collapses a table declared on several forms into one node", () => {
    const formA = `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, INITIALER FROM LARER')
    object f1: TStringField
      FieldName = 'INITIALER'
      Size = 10
    end
  end
end`;
    const formB = `object B: TB
  object q: TpFIBDataSet
    UpdateSQL.Strings = ('UPDATE LARER SET EMAIL_ARB = :EMAIL_ARB WHERE ID = :ID')
    InsertSQL.Strings = ('INSERT INTO LARER (ID, EMAIL_ARB, AKTIV) VALUES (:ID, :E, :A)')
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
      a.classes.filter((c) => c.name === "LARER").map((c) => ({ file: a.filePath, cls: c })),
    );
    expect(declarations).toHaveLength(1);
    // b.dfm knows 3 columns to a.dfm's 2, so it wins and absorbs INITIALER.
    expect(declarations[0]!.file).toBe("b.dfm");
    expect(columnsOf(declarations[0]!.cls)).toEqual({
      ID: null,
      EMAIL_ARB: "varchar(80)",
      AKTIV: "smallint",
      INITIALER: "varchar(10)",
    });
  });

  it("takes the dropped duplicate's type references with it", () => {
    const form = (name: string, sql: string) => `object ${name}: T${name}
  object q: TpFIBDataSet
    InsertSQL.Strings = ('${sql}')
    object f1: TStringField
      FieldName = 'NAVN'
      Size = 30
    end
  end
end`;
    const analyses = [
      parseDfm(form("A", "INSERT INTO LARER (ID, NAVN) VALUES (:ID, :NAVN)"), "a.dfm"),
      parseDfm(form("B", "INSERT INTO LARER (ID) VALUES (:ID)"), "b.dfm"),
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

    // b.dfm lost its LARER node, so nothing in b.dfm may still reference LARER
    // as a containing class — buildClassGraph would resurrect the node from it.
    const loser = analyses.find((a) => !a.classes.some((c) => c.name === "LARER"))!;
    expect(loser.typeReferences?.some((r) => r.sourceClass === "LARER")).toBe(false);
    const winner = analyses.find((a) => a !== loser)!;
    expect(winner.typeReferences?.some((r) => r.sourceClass === "LARER")).toBe(true);
  });

  it("leaves a table declared in only one file alone", () => {
    const analyses = [
      parseDfm(
        `object A: TA
  object q: TpFIBDataSet
    SelectSQL.Strings = ('SELECT ID, NAVN FROM TLANDE')
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
