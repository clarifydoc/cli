import { describe, it, expect } from "vitest";
import { parseDfm } from "../../../parsers/dfm-parser.js";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPascalDataSources, PascalDataSourceExtractor, stripPascalComments } from "./data-sources.js";
import { extractPascalRoutes } from "./routes.js";
import type { RouteInfo } from "../../../types/analysis.js";

const src = (body: string) => extractPascalDataSources(body.split("\n"));

describe("pascal data sources — SQL in strings", () => {
  it("extracts a single-line query", () => {
    const out = src(`Query1.SQL.Text := 'SELECT id, name FROM drivers WHERE active = 1';`);
    const sql = out.find((d) => d.entity === "drivers");
    expect(sql).toBeDefined();
    expect(sql!.kind).toBe("database");
  });

  it("concatenates a statement built across SQL.Add calls", () => {
    const out = src([
      `procedure TForm1.Load;`,
      `begin`,
      `  Query1.SQL.Clear;`,
      `  Query1.SQL.Add('SELECT o.id, o.total');`,
      `  Query1.SQL.Add('FROM cars o');`,
      `  Query1.SQL.Add('WHERE o.status = 1');`,
      `  Query1.Open;`,
      `end;`,
    ].join("\n"));
    const sql = out.find((d) => d.entity === "cars");
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
      `// DELETE FROM players -- disabled`,
      `(* INSERT INTO backlog when ready *)`,
      `X := 1;`,
    ].join("\n"));
    expect(out).toHaveLength(0);
  });
});

describe("pascal data sources — FIBPlus and declared datasets", () => {
  it("reads a dataset the unit declares, whatever its name, and FIBPlus verbs", () => {
    const out = src([
      `type`,
      `  TTeamFrame = class(TFrame)`,
      `    dsPlayers: TpFIBDataSet;`,
      `    qStats, qLaps: TpFIBQuery;`,
      `    mdCache: TdxMemData;`,
      `    memCopy: TFDMemTable;`,
      `  end;`,
      `implementation`,
      `procedure TTeamFrame.btnRemoveClick(Sender: TObject);`,
      `begin`,
      `  dsPlayers.Delete;`,
      `  qStats.ExecQuery;`,
      `  Self.qLaps.CloseOpen(False);`,
      `  mdCache.Delete;`,
      `  memCopy.Post;`,
      `  DM.dsLookup.Open;`,
      `end;`,
    ].join("\n"));
    expect(out.map((d) => d.name)).toEqual(["dsPlayers.Delete", "qStats.ExecQuery", "Self.qLaps.CloseOpen"]);
  });

  it("reads a local created as a dataset", () => {
    const out = src(`  q := TpFIBQuery.Create(nil);\n  q.ExecQuery;`);
    expect(out.map((d) => d.target)).toEqual(["q"]);
  });

  it("keeps one FieldByName row per dataset per routine", () => {
    const out = src([
      `procedure TF.Load(DataSet: TDataSet);`,
      `begin`,
      `  A := DataSet.FieldByName('GOALS').AsInteger;`,
      `  B := DataSet.FieldByName('ASSISTS').AsInteger;`,
      `end;`,
      `procedure TF.Save(DataSet: TDataSet);`,
      `begin`,
      `  C := DataSet.FieldByName('GOALS').AsInteger;`,
      `end;`,
    ].join("\n"));
    expect(out.map((d) => d.line)).toEqual([3, 8]);
  });

  it("never reads a routine header as a call", () => {
    const out = src(`procedure THTTPLapLogThread.Execute;\nbegin\n  Log;\nend;`);
    expect(out).toEqual([]);
  });

  it("carries a builder statement across if-lines and a call whose literal is on the next line", () => {
    const out = src([
      `  ds.SelectSQL.Add('SELECT P.ID');`,
      `  ds.SelectSQL.Add('FROM SP_SEARCH_DRIVERS(:IDS) P');`,
      `  if FTeamID <> 0 then`,
      `    ds.SelectSQL.Add(`,
      `    'INNER JOIN TEAM_DRIVER TD ON TD.DRIVER_ID = P.ID');`,
      `  ds.Open;`,
    ].join("\n"));
    expect(out.filter((d) => !d.name.includes(".")).map((d) => [d.name, d.target, d.line])).toEqual([
      ["EXEC", "SP_SEARCH_DRIVERS", 1],
      ["SELECT", "TEAM_DRIVER", 1],
    ]);
  });
});

describe("pascal data sources — HTTP URLs built before the call", () => {
  const urls = (body: string) => src(body).filter((d) => d.kind === "api-call").map((d) => [d.name, d.target]);

  it("follows a local assigned through a URL helper with concatenation", () => {
    expect(urls([
      `procedure TPhotoService.DeletePhoto(hash: string);`,
      `var URL: String;`,
      `begin`,
      `  URL := ApiUrl('/REST/DriverPhoto/' + hash + '?' + Query);`,
      `  HTTPS.Delete(URL);`,
      `end;`,
    ].join("\n"))).toEqual([["DELETE", "/REST/DriverPhoto/{hash}"]]);
  });

  it("follows Format over a routine constant, and a unit constant", () => {
    expect(urls([
      `const LOG_URI = '/api/Log/Lap';`,
      `procedure TArchive.Store(AId: string);`,
      `const`,
      `  PATH = '/api/Matches/%s/archive';`,
      `begin`,
      `  URL := ApiUrl(Format(PATH, [AId]));`,
      `  HTTPS.Post(URL);`,
      `end;`,
      `procedure TLogger.Log;`,
      `begin`,
      `  FHTTPS.Post(ApiUrl(LOG_URI), Body);`,
      `  HTTPS.GetURL(ApiUrl(Format('/REST/%d/Teams', [Id])));`,
      `end;`,
    ].join("\n"))).toEqual([
      ["POST", "/api/Matches/{}/archive"],
      ["POST", "/api/Log/Lap"],
      ["GET", "/REST/{}/Teams"],
    ]);
  });

  it("leaves a URL that comes from a parameter unresolved", () => {
    expect(urls(`procedure TX.Send(Url: string);\nbegin\n  HTTPS.Post(Url);\nend;`)).toEqual([["POST", null]]);
  });
});

describe("pascal data sources — dataset & connection verbs", () => {
  it("captures receiver-gated dataset verbs", () => {
    const out = src([
      `Query1.Open;`,
      `tblCars.Append;`,
      `cdsPlayers.Post;`,
      `dm.qryStats.ExecSQL;`,
    ].join("\n"));
    const names = out.map((d) => d.name);
    expect(names).toContain("Query1.Open");
    expect(names).toContain("tblCars.Append");
    expect(names).toContain("cdsPlayers.Post");
    expect(names).toContain("dm.qryStats.ExecSQL");
    expect(out.every((d) => d.kind === "database")).toBe(true);
  });

  it("does NOT match unrelated .Open / Open* methods (the old substring noise)", () => {
    const out = src([
      `Windows.OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, hToken);`,
      `OpenDialog1.Execute;`,
      `MyFile.Open;`,
      `RestoreForm.Delete;`,
      `TabControl1.Insert;`,
    ].join("\n"));
    expect(out).toHaveLength(0);
  });

  it("reads a tab-prefixed table component, on a data module of another unit too", () => {
    const out = src([
      `dmLeague.tabTransfers.Insert;`,
      `tabSquads.Open;`,
    ].join("\n"));
    expect(out.map((d) => `${d.name} -> ${d.target}`)).toEqual(["dmLeague.tabTransfers.Insert -> tabTransfers", "tabSquads.Open -> tabSquads"]);
  });
});

describe("pascal data sources — HTTP and config", () => {
  it("captures Indy / REST client verbs with URL targets", () => {
    const out = src(`Response := IdHTTP1.Get('http://api.example.com/players');`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "api-call", name: "GET", target: "http://api.example.com/players" });
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
    expect(routes[0]).toMatchObject({ httpMethod: "POST", path: "/datasnap/rest/TServerMethods1/All" });
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
  Query1.SQL.Add('SELECT * FROM parts');
  Query1.Open;
end;
end.`;
    const tree = await parseSource(code, "pascal" as any, "U.pas");
    const ext = new PascalDataSourceExtractor();
    const out = ext.extract(tree, code);
    expect(out.find((d) => d.entity === "parts")).toBeDefined();
    expect(out.find((d) => d.name === "Query1.Open")).toBeDefined();
    // A second file must not inherit the first file's sources.
    const tree2 = await parseSource("unit V;\ninterface\nimplementation\nend.", "pascal" as any, "V.pas");
    expect(ext.extract(tree2, "unit V;\ninterface\nimplementation\nend.")).toHaveLength(0);
  });
});

describe("REST components configured on the form", () => {
  it("gives the unit's RESTRequest1.Execute the verb and URL its form states", () => {
    const form = parseDfm(`object frmFixtures: TfrmFixtures
  object RESTClient1: TRESTClient
    BaseURL = 'https://data.example.com/api/records/1.0'
    Params = <>
  end
  object RESTRequest1: TRESTRequest
    Client = RESTClient1
    Method = rmPOST
    Params = <
      item
        Name = 'dataset'
        Value = 'fixtures'
      end>
    Resource = 'search'
  end
end
`, "src/fFixtures.fmx");
    const calls = [{ kind: "api-call" as const, name: "RESTRequest1.Execute", target: null, calls: [], line: 104, filePath: "src/fFixtures.pas" }];
    expect(new PascalDataSourceExtractor().resolveProject(calls, [form])).toBe(1);
    expect(calls.map((d) => `${d.name} -> ${d.target}`)).toEqual([
      "POST https://data.example.com/api/records/1.0/search -> https://data.example.com/api/records/1.0/search",
    ]);
  });
});

describe("Pascal text that is shown, not run (real-repo FP)", () => {
  it("reads no table from a highlighter's sample source, a preview control's sample SQL or a keyword list", () => {
    const rows = src(`unit SynHighlighterLeague;
interface
const
  KeyWords: string =
    'frame-row frame-val from from-chars ' +
    'from-pixels gateways get-byte get-codepages ' +
    'select-all side-labels skip-deleted-record squad-list ';
  Types = 'trigger,void,opaque,refcursor,binary,blob,int4,int2';
implementation

function TSynLeagueSyn.GetSampleSource: UnicodeString;
begin
  Result := '-- sample source'#13#10 +
    'SELECT name FROM planets'#13#10 +
    'WHERE moons > 2;';
end;

procedure TfrmPreferences.FormCreate(Sender: TObject);
begin
  SynMemoSQLSample.Text := 'SELECT 1' + sLineBreak +
    'FROM tableA AS ta' + sLineBreak +
    'WHERE x IS NULL;';
  Query.SQL.Text := 'SELECT * FROM clubs';
end;
end.`);
    expect(rows.filter((d) => d.kind === "database").map((d) => d.target)).toEqual(["clubs"]);
  });
});

describe("Pascal UI controls named for a connection (real-repo FP)", () => {
  it("reads an action's Execute as no database access, a connection's Open as one", () => {
    const rows = src(`procedure TMainForm.FormShow(Sender: TObject);
begin
  actConnectionProperties.Execute;
  btnConnectionTest.Execute;
  LeagueConnection.Open;
end;`);
    expect(rows.filter((d) => d.kind === "database").map((d) => d.name)).toEqual(["LeagueConnection.Open"]);
  });
});
