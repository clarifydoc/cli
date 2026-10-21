import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string, path = "jobs/close.vbs") => extractWithRegex(src, path, "vb");
const fn = (src: string, name: string, path?: string) =>
  analyze(src, path).functions.find((f) => f.name === name);
const callNames = (src: string, name: string, path?: string) => fn(src, name, path)?.calls.map((c) => c.name) ?? [];

describe("VBScript top-level statements", () => {
  const SCRIPT = [
    "Option Explicit",
    "Dim conn, n",
    "Set conn = OpenConnection()",
    "n = CountCars(conn)",
    "Report n",
    "Call Cleanup",
    "conn.Close",
    "",
    "Function OpenConnection()",
    '    Set OpenConnection = CreateObject("ADODB.Connection")',
    "End Function",
    "",
    "Sub Report(total)",
    '    WScript.Echo "cars: " & total',
    "End Sub",
  ].join("\n");

  it("become the <setup> pseudo-function, with calls written without parentheses", () => {
    expect(callNames(SCRIPT, "<setup>")).toEqual(["OpenConnection", "CountCars", "Report", "Cleanup", "conn.Close"]);
  });

  it("leave the functions' own calls in the functions", () => {
    expect(callNames(SCRIPT, "OpenConnection")).toEqual(["CreateObject"]);
    expect(fn(SCRIPT, "Report")?.params.map((p) => p.name)).toEqual(["total"]);
  });

  it("are not a pseudo-function in VB.NET or VB6 files", () => {
    expect(fn(SCRIPT, "<setup>", "Module1.vb")).toBeUndefined();
    expect(fn(SCRIPT, "<setup>", "Module1.bas")).toBeUndefined();
  });
});

describe("VB statement calls", () => {
  const body = (lines: string[]) => ["Sub Main()", ...lines, "End Sub"].join("\n");

  it("read a name that opens a statement and assigns nothing as a call", () => {
    expect(callNames(body(["    Log \"x\", 2", "    rs.MoveNext", "    Me.Refresh", "    Err.Raise 5"]), "Main")).toEqual([
      "Log", "rs.MoveNext", "Me.Refresh", "Err.Raise",
    ]);
  });

  it("skip assignments, keywords and operators", () => {
    expect(callNames(body([
      "    total = total + 1",
      "    total += 1",
      "    Dim x",
      "    Erase items",
      "    Exit Sub",
      "    Next",
      "    Loop",
      "    Resume Next",
      "    Return",
      "    x Is Nothing",
    ]), "Main")).toEqual([]);
  });

  it("skip the lines a statement continues onto", () => {
    expect(callNames(body([
      "    If ready AndAlso",
      "       done Then",
      "    End If",
      "    Dim total = a +",
      "                b",
      "    builder _",
      "        .UseMauiApp(Of App)()",
    ]), "Main")).toEqual(["UseMauiApp"]);
  });
});

describe("VB data sources", () => {
  const SRC = [
    "Sub Close(c, id)",
    '    Set rs = c.Execute("SELECT Id FROM Cars WHERE Status = \'shipped\'")',
    "    c.Execute \"UPDATE Cars SET Status = 'closed' \" & _",
    '              "WHERE Id = " & id',
    '    c.Execute "INSERT INTO AuditLog (Message) VALUES (""closed"")" \' log it',
    '    x = ""',
    "    ' c.Execute \"DELETE FROM Cars\"",
    '    http.Open "POST", "https://reports.example.com/api/closed", False',
    '    req.Open "GET", "/api/drivers/" & id, False',
    '    conn.Open "Provider=SQLOLEDB;Data Source=db01"',
    "End Sub",
  ].join("\n");
  const sources = analyze(SRC).dataSources.map((d) => [d.kind, d.name, d.target, d.line]);

  it("read SQL across `_` continuations and `\"\"` escapes, never from comments", () => {
    expect(sources.filter((s) => s[0] === "database")).toEqual([
      ["database", "SELECT", "Cars", 2],
      ["database", "UPDATE", "Cars", 3],
      ["database", "INSERT INTO", "AuditLog", 5],
    ]);
  });

  it("read COM HTTP requests by their verb, and nothing else that opens", () => {
    expect(sources.filter((s) => s[0] === "api-call")).toEqual([
      ["api-call", "POST https://reports.example.com/api/closed", "https://reports.example.com/api/closed", 8],
      ["api-call", "GET /api/drivers/{id}", "/api/drivers/{id}", 9],
    ]);
  });
});
