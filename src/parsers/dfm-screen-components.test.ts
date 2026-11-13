import { describe, it, expect } from "vitest";
import type { ScreenComponentInfo } from "../types/analysis.js";
import { parseDfm } from "./dfm-parser.js";

const FORM = `object frSquad: TfrSquad
  Left = 0
  Top = 0
  Width = 345
  Height = 461
  object gbContract: TcxGroupBox
    Left = 0
    Top = 0
    Caption = 'Contract (caf'#233' squad)'
    Width = 345
    Height = 120
    object lbStart: TcxLabel
      Left = 8
      Top = 12
      Caption = 'Start date:'
    end
    object dedStart: TcxDBDateEdit
      Left = 80
      Top = 10
      Width = 120
      DataBinding.DataField = 'STARTDATE'
      DataBinding.DataSource = srcContract
      Properties.OnValidate = dedStartPropertiesValidate
    end
    object spedShare: TcxDBSpinEdit
      Left = 80
      Top = 60
      Width = 120
      Height = 21
      Properties.DisplayFormat = '###'
      Properties.MaxValue = 100.000000000000000000
      Properties.MinValue = 1.000000000000000000
      Properties.ReadOnly = True
    end
    object spedAny: TcxSpinEdit
      Left = 80
      Top = 90
      Width = 120
      Height = 21
      Properties.MaxValue = 0
      Properties.MinValue = 0
    end
    object edNote: TDBEdit
      Left = 80
      Top = 40
      Width = 120
      Height = 21
      DataField = 'NOTE'
      DataSource = srcContract
    end
    object btnSave: TcxButton
      Left = 8
      Top = 80
      Width = 75
      Height = 25
      Action = actSave
    end
  end
  object grdPlayers: TcxGrid
    Left = 0
    Top = 120
    Width = 345
    Height = 200
    object grdPlayersView: TcxGridDBTableView
      object grdPlayersViewName: TcxGridDBColumn
        Caption = #201'lite '#39'na'#239've'#39
        DataBinding.FieldName = 'NAME'
      end
    end
  end
  object btnRemove: TcxButton
    Left = 8
    Top = 330
    Width = 75
    Height = 25
    Caption = '&Remove'
  end
  object actList: TActionList
    object actSave: TAction
      Caption = 'It''s saved'
      OnExecute = actSaveExecute
    end
  end
end
`;

function find(cs: ScreenComponentInfo[], name: string): ScreenComponentInfo | undefined {
  for (const c of cs) {
    if (c.name === name) return c;
    const hit = find(c.children, name);
    if (hit) return hit;
  }
  return undefined;
}

describe("a form's components on its screen", () => {
  const screen = parseDfm(FORM, "Squad/SquadFrame.dfm").screens![0]!;
  const at = (name: string) => find(screen.components, name)!;

  it("decodes Pascal string literals in captions: #nnn characters, joined parts and doubled quotes", () => {
    expect(at("gbContract").caption).toBe("Contract (café squad)");
    expect(at("grdPlayersViewName").caption).toBe("Élite 'naïve'");
    expect(at("actSave").caption).toBe("It's saved");
    expect(at("btnRemove").caption).toBe("&Remove");
  });

  it("binds a control to its action and data field, for the plain and the DataBinding spelling", () => {
    expect(at("btnSave").dataBindings).toEqual(["Action=actSave"]);
    expect(at("dedStart").dataBindings).toEqual(["DataField=STARTDATE", "DataSource=srcContract"]);
    expect(at("edNote").dataBindings).toEqual(["DataSource=srcContract", "DataField=NOTE"]);
    expect(at("grdPlayersViewName").dataBindings).toEqual(["FieldName=NAME"]);
  });

  it("places an auto-sized control by its origin, leaving its position unknown", () => {
    expect(at("lbStart").position).toBeNull();
    expect(at("lbStart").origin).toEqual({ left: 8, top: 12 });
    expect(at("dedStart").origin).toEqual({ left: 80, top: 10 });
    expect(at("btnSave").origin).toBeUndefined();
  });

  it("reads what the form constrains a field to, and an editor's own events", () => {
    expect(at("spedShare").constraints).toEqual({ min: "1", max: "100", readOnly: true, format: "###" });
    expect(at("spedAny").constraints).toBeUndefined();
    expect(at("dedStart").events).toEqual(["OnValidate"]);
  });

  it("keeps a binding that names no data component out of the data sources", () => {
    const a = parseDfm(FORM, "Squad/SquadFrame.dfm");
    expect(a.dataSources.map((d) => d.name).sort()).toEqual(["edNote.DataSource"]);
  });
});
