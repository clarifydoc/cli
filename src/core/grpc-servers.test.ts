import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * gRPC services implemented through protoc's generated bases, and a ts-proto
 * client (real-repo FP: 0 of 20 rpcs anchored, every client call a database read).
 */
const FILES: Record<string, string> = {
  "pb/league.proto": `syntax = "proto3";
package league;

service FixtureService { rpc GetFixture (FixtureRequest) returns (Fixture); }
service SquadService { rpc ListPlayers (SquadRequest) returns (Squad); }
service TableService { rpc GetTable (TableRequest) returns (Table); }
service RefereeService { rpc Assign (AssignRequest) returns (Assignment); }
message FixtureRequest { string id = 1; }
message Fixture { string id = 1; }
message SquadRequest { string club = 1; }
message Squad { repeated string players = 1; }
message TableRequest { string season = 1; }
message Table { repeated string rows = 1; }
message AssignRequest { string match = 1; }
message Assignment { string referee = 1; }
`,
  "fixtures/Fixtures.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
  "fixtures/FixtureService.cs": `namespace Fixtures;

public class FixtureService : League.FixtureService.FixtureServiceBase
{
    public override Task<Fixture> GetFixture(FixtureRequest request, ServerCallContext context) => Task.FromResult(new Fixture());
}
`,
  "squads/pom.xml": `<project><groupId>com.example</groupId><artifactId>squads</artifactId></project>`,
  "squads/src/main/java/com/example/squads/SquadServer.java": `package com.example.squads;

public class SquadServer extends league.SquadServiceGrpc.SquadServiceImplBase {
    @Override
    public void listPlayers(SquadRequest request, StreamObserver<Squad> observer) { observer.onCompleted(); }
}
`,
  "table/go.mod": `module example.com/table\n\ngo 1.22\n`,
  "table/main.go": `package main

import pb "example.com/table/pb"

type tableServer struct {
	pb.UnimplementedTableServiceServer
}

func (t *tableServer) GetTable(ctx context.Context, req *pb.TableRequest) (*pb.Table, error) {
	return &pb.Table{}, nil
}
`,
  "referees/referee_server.py": `import league_pb2_grpc


class Referees(league_pb2_grpc.RefereeServiceServicer):
    def Assign(self, request, context):
        return None
`,
  "web/package.json": `{"name":"web","dependencies":{"@grpc/grpc-js":"^1.10.0"}}`,
  "web/gateways/fixtures.ts": `import { ChannelCredentials } from "@grpc/grpc-js";
import { FixtureServiceClient } from "../protos/league";

const client = new FixtureServiceClient("fixtures:8080", ChannelCredentials.createInsecure());

export const getFixture = (id: string) => new Promise((resolve) => client.getFixture({ id }, (_e, r) => resolve(r)));
`,
};

describe("gRPC services through protoc's generated bases", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-grpc-servers-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("anchor each rpc on its implementing method", () => {
    const joins = summary.symbolLinks.filter((l) => l.strategy === "spec-join").map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(joins).toEqual([
      "route:POST /league.FixtureService/GetFixture -> FixtureService.GetFixture",
      "route:POST /league.RefereeService/Assign -> Referees.Assign",
      "route:POST /league.SquadService/ListPlayers -> SquadServer.listPlayers",
      "route:POST /league.TableService/GetTable -> tableServer.GetTable",
    ]);
  });

  it("read a ts-proto client's call as the rpc, and the edge goes to the implementing service", () => {
    expect((summary.apiCalls ?? []).filter((c) => c.filePath === "web/gateways/fixtures.ts").map((c) => c.target)).toEqual(["/league.FixtureService/GetFixture"]);
    expect((summary.projectDependencies ?? []).map((d) => `${d.from} -> ${d.to}`)).toContain("web -> fixtures");
  });
});
