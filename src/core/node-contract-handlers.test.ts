import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** Node servers handing their rpc handlers in the call: a Thrift service and a gRPC one, with namesake decoys. */
const FILES: Record<string, string> = {
  "idl/league.thrift": `namespace java com.example.league
struct Club { 1: string name }
service ClubService {
  Club getClub(1: string id),
  list<Club> listClubs(),
  Club findClub(1: string id),
  void ping(),
  void sponsor()
}
`,
  "idl/match.proto": `syntax = "proto3";
package com.example.league;
service MatchService {
  rpc GetMatch (MatchRequest) returns (MatchReply);
  rpc ListMatches (MatchRequest) returns (MatchReply);
}
message MatchRequest { string id = 1; }
message MatchReply { string id = 1; }
`,
  "lib/clubs.js": `exports.getClub = function (id, done) { return lookupClub(id, done); };
function lookupClub(id, done) { done(null, {}); }
`,
  "lib/decoy.js": `function getClub(id) { return 1; }
function ping() { return 2; }
module.exports = { getClub, ping };
`,
  "lib/store.js": `exports.save = function (club) { return club; };
exports.load = function (id) { return id; };
`,
  "server.js": `const thrift = require("thrift");
const ClubService = require("./gen/ClubService");
const clubs = require("./lib/clubs");
const { load } = require("./lib/store");
const store = require("./lib/store");
function pingHandler(result) { result(null); }
function makeHandler() { return () => 1; }
thrift.createServer(ClubService, {
  getClub: clubs.getClub,
  async listClubs() {
    return store.load("all");
  },
  findClub: (id, done) => load(id),
  ping: pingHandler,
  sponsor: makeHandler(),
});
`,
  "grpc.js": `const grpc = require("@grpc/grpc-js");
const store = require("./lib/store");
const server = new grpc.Server();
server.addService(proto.com.example.league.MatchService.service, {
  getMatch: (call, cb) => {
    cb(null, store.load(call.request.id));
  },
  listMatches(call, cb) {
    cb(null, store.save(call.request));
  },
});
`,
};

describe("Node RPC handlers written in the registering call", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-node-handlers-"));
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

  it("makes each member a function of its own and puts the contract row on it", async () => {
    const s = await loadReportSummary(out);
    const rows = s.routeMap.filter((r) => r.contract && (r.filePath === "server.js" || r.filePath === "grpc.js")).map((r) => `${r.filePath} ${r.contract!.method}:${r.handler}`).sort();
    expect(rows).toEqual([
      "grpc.js GetMatch:addService.getMatch",
      "grpc.js ListMatches:addService.listMatches",
      "server.js findClub:createServer.findClub",
      "server.js getClub:createServer.getClub",
      "server.js listClubs:createServer.listClubs",
      "server.js ping:createServer.ping",
    ]);
    // `sponsor: makeHandler()` is a call result, no handler.
    expect(rows.some((r) => r.includes("sponsor"))).toBe(false);
  });

  it("attributes the bodies' calls to the member functions", async () => {
    const s = await loadReportSummary(out);
    const from = (file: string, symbol: string) => s.symbolLinks.filter((l) => l.sourceFile === file && l.sourceSymbol === symbol).map((l) => `${l.targetFile}:${l.targetSymbol}`).sort();
    expect(from("server.js", "createServer.listClubs")).toEqual(["lib/store.js:load"]);
    expect(from("server.js", "createServer.findClub")).toEqual(["lib/store.js:load"]);
    expect(from("grpc.js", "addService.getMatch")).toEqual(["lib/store.js:load"]);
    expect(from("grpc.js", "addService.listMatches")).toEqual(["lib/store.js:save"]);
  });

  it("does not leave a handler's calls on the function that registers it", async () => {
    const s = await loadReportSummary(out);
    const fromSetup = s.symbolLinks.filter((l) => (l.sourceFile === "server.js" || l.sourceFile === "grpc.js") && l.sourceSymbol === "<setup>" && l.targetFile === "lib/store.js" && l.relation === "calls");
    expect(fromSetup).toEqual([]);
  });

  it("hands a named member on to the function it names, never to a namesake", async () => {
    const s = await loadReportSummary(out);
    const from = (symbol: string) => s.symbolLinks.filter((l) => l.sourceFile === "server.js" && l.sourceSymbol === symbol).map((l) => `${l.targetFile}:${l.targetSymbol} ${l.relation}`);
    expect(from("createServer.ping")).toEqual(["server.js:pingHandler passes"]);
    expect(from("createServer.getClub")).toEqual(["lib/clubs.js:getClub passes"]);
    expect(s.symbolLinks.some((l) => l.targetFile === "lib/decoy.js")).toBe(false);
  });

  it("joins the spec rows to the handlers", async () => {
    const s = await loadReportSummary(out);
    const joins = s.symbolLinks
      .filter((l) => l.strategy === "spec-join" && /\/com\.example\.league\.(ClubService|MatchService)\//.test(l.sourceSymbol))
      .map((l) => `${l.sourceSymbol.split("/").pop()} -> ${l.targetFile}`)
      .sort();
    expect(joins).toEqual([
      "findClub -> server.js",
      "getClub -> server.js",
      "listClubs -> server.js",
      "ping -> server.js",
      "GetMatch -> grpc.js",
      "ListMatches -> grpc.js",
    ].sort());
  });
});
