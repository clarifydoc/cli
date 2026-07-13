import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPascalDataSources, PascalDataSourceExtractor, stripPascalComments } from "./data-sources.js";
import { extractPascalRoutes } from "./routes.js";
import type { RouteInfo } from "../../../types/analysis.js";

const src = (body: string) => extractPascalDataSources(body.split("\n"));

describe("pascal data sources — SQL in strings", () => {
  it("extracts a single-line query", () => {
    const out = src(`Query1.SQL.Text := 'SELECT id, name FROM customers WHERE active = 1';`);
    const sql = out.find((d) => d.entity === "customers");
    expect(sql).toBeDefined();
    expect(sql!.kind).toBe("database");
  });

  it("concatenates a statement built across SQL.Add calls", () => {
    const out = src([
      `procedure TForm1.Load;`,
      `begin`,
      `  Query1.SQL.Clear;`,
      `  Query1.SQL.Add('SELECT o.id, o.total');`,
      `  Query1.SQL.Add('FROM orders o');`,
      `  Query1.SQL.Add('WHERE o.status = 1');`,
      `  Query1.Open;`,
      `end;`,
    ].join("\n"));
    const sql = out.find((d) => d.entity === "orders");
    expect(sql).toBeDefined();
  });

  it("handles doubled-quote escapes and + concatenation", () => {
    const out = src(`S := 'INSERT INTO logs (msg) ' + 'VALUES (''it''''s'')';`);
    expect(out.find((d) => d.entity === "logs")).toBeDefined();
  });

  it("drops queries whose table is a runtime variable", () => {
    const out = src(`Query := Format('SELECT * FROM %s WHERE id = %d', [TBName, Id]);`);
    expect(out.filter((d) => d.kind === "database")).toHaveLength(0);
  });

  it("ignores SQL keywords inside comments", () => {
    const out = src([
      `{ SELECT the best item FROM the list below }`,
      `// DELETE FROM users -- disabled`,
      `(* INSERT INTO backlog when ready *)`,
      `X := 1;`,
    ].join("\n"));
    expect(out).toHaveLength(0);
  });
});

describe("pascal data sources — dataset & connection verbs", () => {
  it("captures receiver-gated dataset verbs", () => {
    const out = src([
      `Query1.Open;`,
      `tblOrders.Append;`,
      `cdsUsers.Post;`,
      `dm.qryStats.ExecSQL;`,
    ].join("\n"));
    const names = out.map((d) => d.name);
    expect(names).toContain("Query1.Open");
    expect(names).toContain("tblOrders.Append");
    expect(names).toContain("cdsUsers.Post");
    expect(names).toContain("dm.qryStats.ExecSQL");
    expect(out.every((d) => d.kind === "database")).toBe(true);
  });

  it("does NOT match unrelated .Open / Open* methods (the old substring noise)", () => {
    const out = src([
      `Windows.OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, hToken);`,
      `OpenDialog1.Execute;`,
      `MyFile.Open;`,
      `RestoreForm.Delete;`,
    ].join("\n"));
    expect(out).toHaveLength(0);
  });
});

describe("pascal data sources — HTTP and config", () => {
  it("captures Indy / REST client verbs with URL targets", () => {
    const out = src(`Response := IdHTTP1.Get('http://api.example.com/users');`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "api-call", name: "GET", target: "http://api.example.com/users" });
  });

  it("captures WinINet calls (server literal for Connect, url for OpenUrl)", () => {
    const out = src([
      `hConnect := InternetConnect(hSession, 'www.example.com', INTERNET_DEFAULT_HTTP_PORT, nil, nil, INTERNET_SERVICE_HTTP, 0, 0);`,
      `hUrl := InternetOpenUrl(hSession, 'http://example.com/data.xml', nil, 0, 0, 0);`,
      `hReq := HttpOpenRequest(hConnect, PChar('POST'), PChar(QueryStr), HTTP_VERSION, nil, nil, 0, 0);`,
    ].join("\n"));
    expect(out.find((d) => d.name === "InternetConnect")!.target).toBe("www.example.com");
    expect(out.find((d) => d.name === "InternetOpenUrl")!.target).toBe("http://example.com/data.xml");
    expect(out.find((d) => d.name === "HttpOpenRequest")).toBeDefined();
  });

  it("captures ShellExecute only when it opens a web URL", () => {
    const out = src([
      `ShellExecuteA(Handle, 'open', 'http://www.example.org/page', '', '', SW_SHOW);`,
      `ShellExecute(Handle, 'open', PChar(DocPath), nil, nil, SW_SHOW);`,
    ].join("\n"));
    expect(out).toHaveLength(1);
    expect(out[0]!.target).toBe("http://www.example.org/page");
  });

  it("captures ini/registry/env reads as env sources", () => {
    const out = src([
      `S := Ini.ReadString('Server', 'Host', 'localhost');`,
      `Reg.OpenKey('Software\\MyApp', False);`,
      `V := GetEnvironmentVariable('APP_MODE');`,
    ].join("\n"));
    expect(out.map((d) => d.kind)).toEqual(["env", "env", "env"]);
    expect(out[0]!.target).toBe("Server");
    expect(out[2]!.target).toBe("APP_MODE");
  });
});

describe("stripPascalComments", () => {
  it("tracks multi-line brace comments and preserves strings with braces", () => {
    const out = stripPascalComments([
      `A := 1; { start`,
      `  still comment SELECT * FROM x`,
      `} B := '{ not a comment }';`,
    ]);
    expect(out[0]).toBe("A := 1; ");
    expect(out[1]).toBe("");
    expect(out[2]).toBe(" B := '{ not a comment }';");
  });
});

describe("pascal routes — DataSnap gate", () => {
  const UNIT = (uses: string) => `unit ServerMethods;
interface
uses ${uses};
type
  TServerMethods1 = class(TDSServerModule)
  public
    function UpdateAll(Value: string): string;
  end;
implementation
function TServerMethods1.UpdateAll(Value: string): string;
begin
  Result := Value;
end;
end.`;

  it("emits routes when DataSnap evidence is present", async () => {
    const code = UNIT("System.SysUtils, Datasnap.DSServer");
    const tree = await parseSource(code, "pascal" as any, "ServerMethods.pas");
    const routes: RouteInfo[] = [];
    extractPascalRoutes(tree.rootNode, routes, code);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ httpMethod: "PUT", path: "/All" });
  });

  it("stays silent for plain VCL units (no phantom PUT /All per Update*)", async () => {
    const code = `unit UMainForm;
interface
type
  TMainForm = class(TForm)
  public
    procedure UpdateAll;
  end;
implementation
procedure TMainForm.UpdateAll;
begin
end;
end.`;
    const tree = await parseSource(code, "pascal" as any, "UMainForm.pas");
    const routes: RouteInfo[] = [];
    extractPascalRoutes(tree.rootNode, routes, code);
    expect(routes).toHaveLength(0);
  });
});

describe("PascalDataSourceExtractor (AST entry point)", () => {
  it("flushes line-scanned sources once via the root visit", async () => {
    const code = `unit U;
interface
implementation
procedure Load;
begin
  Query1.SQL.Add('SELECT * FROM products');
  Query1.Open;
end;
end.`;
    const tree = await parseSource(code, "pascal" as any, "U.pas");
    const ext = new PascalDataSourceExtractor();
    const out = ext.extract(tree, code);
    expect(out.find((d) => d.entity === "products")).toBeDefined();
    expect(out.find((d) => d.name === "Query1.Open")).toBeDefined();
    // A second file must not inherit the first file's sources.
    const tree2 = await parseSource("unit V;\ninterface\nimplementation\nend.", "pascal" as any, "V.pas");
    expect(ext.extract(tree2, "unit V;\ninterface\nimplementation\nend.")).toHaveLength(0);
  });
});
