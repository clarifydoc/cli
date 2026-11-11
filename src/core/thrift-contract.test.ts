import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A Thrift contract, its Java implementation, two clients (Java, Python) and a decoy `Client`. */
const FILES: Record<string, string> = {
  "idl/shared.thrift": `namespace java com.example.league
// Every service can answer a version query.
service BaseService {
  string version()
}
`,
  "idl/league.thrift": `namespace java com.example.league
namespace py league
include "shared.thrift"

enum Position { KEEPER = 1, DEFENDER = 2 }
exception NotFound { 1: string message }
struct Player { 1: required string name, 2: Position position }
/* service Fake { void nope() } */
struct Club {
  1: required string name,
  2: optional i32 founded,
  3: list<Player> squad,
  4: map<string, i64> points
}
service ClubService extends shared.BaseService {
  Club getClub(1: string id) throws (1: NotFound nf),
  list<Club> clubs(1: i32 limit = 10, 2: string league),
  oneway void ping()
}
`,
  "server/ClubHandler.java": `package com.example.league;
import org.apache.thrift.TException;
public class ClubHandler implements ClubService.Iface {
  public Club getClub(String id) throws TException { return null; }
  public java.util.List<Club> clubs(int limit, String league) { return null; }
  public void ping() {}
  public String version() { return "1"; }
}
`,
  "client/Scout.java": `package com.example.scout;
import org.apache.thrift.protocol.TBinaryProtocol;
import com.example.league.ClubService;
public class Scout {
  public void visit(TBinaryProtocol protocol) throws Exception {
    ClubService.Client client = new ClubService.Client(protocol);
    client.getClub("c1");
  }
}
`,
  "client/scout.py": `from thrift.protocol import TBinaryProtocol
from league import ClubService

def visit(protocol):
    client = ClubService.Client(protocol)
    return client.clubs(5, "premier")
`,
  "client/Decoy.java": `package com.example.decoy;
public class Decoy {
  static class Client { void getClub(String id) {} }
  public void run() {
    Client client = new Client();
    client.getClub("c1");
  }
}
`,
};

describe("Thrift as a contract", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-thrift-"));
    for (const [p, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "src", p)), { recursive: true });
      await writeFile(join(dir, "src", p), text);
    }
    out = join(dir, "out");
    await analyze({ projectRoot: join(dir, "src"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each method at its namespace-qualified path, the base service's too", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual([
      "POST /com.example.league.BaseService/version version",
      "POST /com.example.league.ClubService/clubs clubs",
      "POST /com.example.league.ClubService/getClub getClub",
      "POST /com.example.league.ClubService/ping ping",
      "POST /com.example.league.ClubService/version version",
    ]);
    const get = s.routeMap.find((r) => r.path.endsWith("ClubService/getClub"));
    expect(Object.keys(get?.requestSchema?.properties ?? {})).toEqual(["id"]);
  });

  it("joins each method to the Java implementation and each stub call to its row", async () => {
    const s = await loadReportSummary(out);
    const joins = s.symbolLinks.filter((l) => l.strategy === "spec-join").map((l) => `${l.sourceSymbol} -> ${l.targetFile} ${l.targetSymbol}`);
    expect(joins).toContain("route:POST /com.example.league.ClubService/getClub -> server/ClubHandler.java ClubHandler.getClub");
    expect(joins).toContain("route:POST /com.example.league.ClubService/clubs -> server/ClubHandler.java ClubHandler.clubs");
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url}`).sort()).toEqual([
      "client/Scout.java POST /com.example.league.ClubService/getClub",
      "client/scout.py POST /com.example.league.ClubService/clubs",
    ]);
    // A class named Client that no Thrift service declares links nothing.
    expect((s.apiRouteLinks ?? []).some((l) => l.source.includes("Decoy"))).toBe(false);
  });
});

/** Handlers the generated code never names: Go, Python and Node servers, a Node client, and decoys. */
const DYNAMIC: Record<string, string> = {
  "idl/league.thrift": `namespace java com.example.league
struct Club { 1: string name }
service ClubService {
  Club getClub(1: string id),
  list<Club> clubs(1: i32 limit)
}
`,
  "go/server.go": `package main

import "github.com/apache/thrift/lib/go/thrift"

type clubHandler struct{}

func (h *clubHandler) GetClub(ctx context.Context, id string) (*Club, error) { return nil, nil }
func (h *clubHandler) Clubs(ctx context.Context, limit int32) ([]*Club, error) { return nil, nil }

func serve() {
	processor := league.NewClubServiceProcessor(&clubHandler{})
	_ = thrift.NewTSimpleServer4(processor, nil, nil, nil)
}
`,
  "go/decoy.go": `package main

type FanClient struct{}
type fanHandler struct{}

func (h *fanHandler) GetClub(id string) {}

func run(c FanClient) { c.GetClub("x") }
`,
  "py/server.py": `from thrift.server import TServer
from league import ClubService

class ClubHandler:
    def getClub(self, id):
        return None
    def clubs(self, limit):
        return []

def serve():
    handler = ClubHandler()
    processor = ClubService.Processor(handler)
    return TServer.TSimpleServer(processor, None)
`,
  "py/decoy.py": `class StandsHandler:
    def getClub(self, id):
        return None
`,
  "node/scout.js": `const thrift = require("thrift");
const ClubService = require("./gen/ClubService");
async function visit(conn) {
  const client = thrift.createClient(ClubService, conn);
  return client.getClub("c1");
}
`,
  "node/server.js": `const thrift = require("thrift");
const ClubService = require("./gen/ClubService");
class NodeClubHandler {
  getClub(id, result) { result(null, {}); }
  clubs(limit, result) { result(null, []); }
}
const handler = new NodeClubHandler();
thrift.createServer(ClubService, handler);
`,
  "node/decoy.js": `function createClient(Service, conn) { return conn; }
function visit(conn) {
  const client = createClient(Service, conn);
  return client.getClub("c1");
}
`,
};

describe("Thrift handlers and clients the generated code does not name", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-thrift-dyn-"));
    for (const [p, text] of Object.entries(DYNAMIC)) {
      await mkdir(dirname(join(dir, "src", p)), { recursive: true });
      await writeFile(join(dir, "src", p), text);
    }
    out = join(dir, "out");
    await analyze({ projectRoot: join(dir, "src"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives a processor's handler class, in Go, Python and Node, the rows it implements", async () => {
    const s = await loadReportSummary(out);
    const served = (f: string) => s.routeMap.filter((r) => r.filePath === f && r.contract).map((r) => `${r.contract!.method}:${r.handler}`).sort();
    expect(served("go/server.go")).toEqual(["clubs:clubHandler.Clubs", "getClub:clubHandler.GetClub"]);
    expect(served("py/server.py")).toEqual(["clubs:ClubHandler.clubs", "getClub:ClubHandler.getClub"]);
    expect(served("node/server.js")).toEqual(["clubs:NodeClubHandler.clubs", "getClub:NodeClubHandler.getClub"]);
    // Classes no processor receives serve nothing.
    expect(served("go/decoy.go")).toEqual([]);
    expect(served("py/decoy.py")).toEqual([]);
  });

  it("links a Node client's call to the row, and an unrelated createClient to nothing", async () => {
    const s = await loadReportSummary(out);
    const links = (s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url}`);
    expect(links).toEqual(["node/scout.js POST /com.example.league.ClubService/getClub"]);
  });
});

describe("Thrift row joined to the one Python handler", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-thrift-py-"));
    for (const p of ["idl/league.thrift", "py/server.py", "py/decoy.py"]) {
      await mkdir(dirname(join(dir, "src", p)), { recursive: true });
      await writeFile(join(dir, "src", p), DYNAMIC[p]!);
    }
    out = join(dir, "out");
    await analyze({ projectRoot: join(dir, "src"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the handler's methods through the spec join, and the decoy's none", async () => {
    const s = await loadReportSummary(out);
    const targets = s.symbolLinks.filter((l) => l.strategy === "spec-join" && l.sourceSymbol.startsWith("route:POST /com.example.league.ClubService/")).map((l) => `${l.sourceSymbol.split("/").pop()} -> ${l.targetFile}`);
    expect(targets.sort()).toEqual(["clubs -> py/server.py", "getClub -> py/server.py"]);
  });
});
