import { describe, it, expect } from "vitest";
import { binaryDfmToText, isBinaryDfm } from "./dfm-binary.js";
import { parseDfm } from "./dfm-parser.js";

/** Build a latin1 byte string from mixed fragments (numbers = raw bytes). */
function bytes(...parts: (number | string)[]): string {
  let out = "";
  for (const p of parts) {
    out += typeof p === "number" ? String.fromCharCode(p) : p;
  }
  return out;
}

/** Byte-length-prefixed short string. */
function s(str: string): string {
  return bytes(str.length, str);
}

// TValueType tags used below.
const vaList = 1, vaInt8 = 2, vaInt16 = 3, vaString = 6, vaIdent = 7,
  vaFalse = 8, vaSet = 11, vaCollection = 14;

/** A realistic binary form: resource wrapper + TPF0 + nested components. */
function sampleBinary(): string {
  return bytes(
    // 16-bit resource wrapper as Delphi writes it: FF 0A 00 NAME 00 <u32 size>
    0xff, 0x0a, 0x00, "TFRMMAIN", 0x00, 0x10, 0x20, 0x00, 0x00,
    "TPF0",
    s("TfrmMain"), s("frmMain"),
    s("Left"), vaInt16, 0xe4, 0x00,
    s("Caption"), vaString, s("Main Window"),
    s("BorderIcons"), vaSet, s("biSystemMenu"), s("biMinimize"), 0x00,
    s("OnCreate"), vaIdent, s("FormCreate"),
    0x00, // end of props
    // child 1: a button with a click handler
    s("TButton"), s("btnClose"),
    s("Left"), vaInt8, 10,
    s("Caption"), vaString, s("Close"),
    s("OnClick"), vaIdent, s("btnCloseClick"),
    0x00,
    0x00, // no grandchildren
    // child 2: a grid with a collection property (must be skipped correctly)
    s("TListView"), s("lvFiles"),
    s("Columns"), vaCollection,
      vaList, s("Caption"), vaString, s("Name"), 0x00,
      vaList, s("Caption"), vaString, s("Size"), 0x00,
    0x00,
    s("Visible"), vaFalse,
    0x00,
    0x00,
    // child 3: a query carrying its SQL in the form
    s("TQuery"), s("qryUsers"),
    s("SQL.Strings"), vaList,
      vaString, s("SELECT id, name"),
      vaString, s("FROM users"),
      vaString, s("WHERE active = 1"),
    0x00,
    0x00,
    0x00,
    // child 4: a BDE table naming its table file
    s("TTable"), s("tblOrders"),
    s("TableName"), vaString, s("ORDERS.DB"),
    0x00,
    0x00,
    0x00, // end of root's children
  );
}

describe("isBinaryDfm", () => {
  it("detects the TPF0 stream behind the resource wrapper", () => {
    expect(isBinaryDfm(sampleBinary())).toBe(true);
  });

  it("detects a bare TPF0 stream (no wrapper)", () => {
    const raw = bytes("TPF0", s("TForm1"), s("Form1"), 0x00, 0x00);
    expect(isBinaryDfm(raw)).toBe(true);
  });

  it("rejects text DFMs", () => {
    expect(isBinaryDfm("object Form1: TForm1\nend\n")).toBe(false);
    // Even ones that mention TPF0 in a caption
    expect(isBinaryDfm("object Form1: TForm1\n  Caption = 'TPF0'\nend\n")).toBe(false);
  });
});

describe("binaryDfmToText", () => {
  it("converts the object tree with properties, events, sets and lists", () => {
    const text = binaryDfmToText(sampleBinary())!;
    expect(text).toContain("object frmMain: TfrmMain");
    expect(text).toContain("Left = 228");
    expect(text).toContain("Caption = 'Main Window'");
    expect(text).toContain("BorderIcons = [biSystemMenu, biMinimize]");
    expect(text).toContain("OnCreate = FormCreate");
    expect(text).toContain("object btnClose: TButton");
    expect(text).toContain("OnClick = btnCloseClick");
    // Collection consumed without derailing the following property
    expect(text).toContain("Columns = <>");
    expect(text).toContain("Visible = False");
    expect(text).toContain("SQL.Strings = ('SELECT id, name' 'FROM users' 'WHERE active = 1')");
    expect(text).toContain("TableName = 'ORDERS.DB'");
    // Balanced object/end
    const objects = text.match(/^\s*object /gm)!.length;
    const ends = text.match(/^\s*end$/gm)!.length;
    expect(objects).toBe(ends);
  });

  it("salvages a truncated stream by closing open objects", () => {
    const full = sampleBinary();
    const truncated = full.slice(0, full.indexOf("btnCloseClick") + 5);
    const text = binaryDfmToText(truncated);
    expect(text).toContain("object frmMain: TfrmMain");
    const objects = text!.match(/^\s*object /gm)!.length;
    const ends = text!.match(/^\s*end$/gm)!.length;
    expect(objects).toBe(ends);
  });

  it("returns null when no signature is present", () => {
    expect(binaryDfmToText("garbage")).toBeNull();
  });
});

describe("parseDfm on binary input", () => {
  const analysis = parseDfm(sampleBinary(), "src/frmMain.dfm");

  it("produces the screen with components", () => {
    expect(analysis.screens).toHaveLength(1);
    const screen = analysis.screens[0]!;
    expect(screen.name).toBe("frmMain");
    expect(screen.caption).toBe("Main Window");
    const names = screen.components.map((c) => c.name);
    expect(names).toContain("btnClose");
    expect(names).toContain("lvFiles");
  });

  it("wires interactive elements to their handlers", () => {
    const click = analysis.interactiveElements.find((e) => e.handler === "btnCloseClick");
    expect(click).toBeDefined();
    expect(click!.element).toBe("button");
    expect(click!.event).toBe("OnClick");
    const create = analysis.interactiveElements.find((e) => e.handler === "FormCreate");
    expect(create).toBeDefined();
    expect(create!.element).toBe("form");
  });

  it("extracts database sources from SQL.Strings and TableName", () => {
    const db = analysis.dataSources.filter((d) => d.kind === "database");
    const sql = db.find((d) => d.name.startsWith("qryUsers"));
    expect(sql).toBeDefined();
    expect(sql!.target).toBe("users");
    expect(sql!.entity).toBe("users");
    const table = db.find((d) => d.name === "tblOrders.TableName");
    expect(table).toBeDefined();
    expect(table!.target).toBe("ORDERS");
    expect(table!.entity).toBe("ORDERS");
  });
});

describe("parseDfm text DFM with multi-line SQL", () => {
  const text = [
    "object frmData: TfrmData",
    "  Caption = 'Data'",
    "  object qryOrders: TQuery",
    "    SQL.Strings = (",
    "      'SELECT o.id, o.total'",
    "      'FROM orders o'",
    "      'JOIN customers c ON c.id = o.customer_id')",
    "    Left = 40",
    "  end",
    "  object tblItems: TTable",
    "    TableName = 'items.dbf'",
    "  end",
    "end",
  ].join("\n");
  const analysis = parseDfm(text, "src/frmData.dfm");

  it("joins the SQL list and resolves the table", () => {
    const sql = analysis.dataSources.find((d) => d.name.startsWith("qryOrders"));
    expect(sql).toBeDefined();
    expect(sql!.target).toBe("orders");
  });

  it("keeps parsing properties after the list closes", () => {
    const table = analysis.dataSources.find((d) => d.name === "tblItems.TableName");
    expect(table).toBeDefined();
    expect(table!.target).toBe("items");
  });

  it("publishes component→table constants for the cross-file datastore join", () => {
    // resolveDataSourceStringConstants rewrites the companion unit's
    // `qryOrders.Open` (entity/target = component name) to the real table.
    expect(analysis.stringConstants).toEqual({
      qryOrders: "orders",
      tblItems: "items",
    });
  });
});

describe("parseDfm on Lazarus .lfm content", () => {
  it("parses the same object syntax (screens + events)", () => {
    const text = [
      "object Form1: TForm1",
      "  Caption = 'Lazarus App'",
      "  object btnGo: TButton",
      "    Caption = 'Go'",
      "    OnClick = btnGoClick",
      "  end",
      "end",
    ].join("\n");
    const a = parseDfm(text, "src/unit1.lfm");
    expect(a.screens).toHaveLength(1);
    expect(a.interactiveElements.find((e) => e.handler === "btnGoClick")).toBeDefined();
  });
});
