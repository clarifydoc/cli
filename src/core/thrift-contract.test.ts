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
