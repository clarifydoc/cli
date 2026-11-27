import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A gRPC rpc's handler is a class tied to its service (it extends protoc's generated base); a class that only
 * has a method of the rpc's name, or a test double, is not one — the client's call must not reach either.
 * Each language holds a served service's `Kickoff` (a real servicer beside both decoys) and an unserved service's `Whistle`
 * (decoys only: nothing serves it), under service names of its own.
 */
const proto = (served: string, orphan: string): string => `syntax = "proto3";
package league;
service ${served}Service { rpc Kickoff (Req) returns (Res); }
service ${orphan}Service { rpc Whistle (Req) returns (Res); }
message Req {}
message Res {}
`;

const FILES: Record<string, string> = {
  "py/league.proto": proto("Match", "Referee"),
  "py/real.py": `import league_pb2_grpc

def go(channel, req):
    league_pb2_grpc.MatchServiceStub(channel).Kickoff(req)
    league_pb2_grpc.RefereeServiceStub(channel).Whistle(req)
`,
  "py/impl.py": `import league_pb2_grpc

class MatchServicer(league_pb2_grpc.MatchServiceServicer):
    def Kickoff(self, request, context):
        return None
`,
  "py/garage.py": `class Garage:
    def Kickoff(self):
        pass

    def Whistle(self):
        pass
`,
  "py/test_x.py": `class _MatchStub:
    def Kickoff(self, req):
        return None

    def Whistle(self, req):
        return None
`,
  "go/go.mod": "module example.com/league\n\ngo 1.22\n",
  "go/league.proto": proto("Club", "Linesman"),
  "go/client.go": `package league

import pb "example.com/league/leaguepb"

func Go(conn *grpc.ClientConn) {
	m := pb.NewClubServiceClient(conn)
	m.Kickoff(ctx, &pb.Req{})
	r := pb.NewLinesmanServiceClient(conn)
	r.Whistle(ctx, &pb.Req{})
}
`,
  "go/server.go": `package league

import pb "example.com/league/leaguepb"

type server struct {
	pb.UnimplementedClubServiceServer
}

func (s *server) Kickoff(ctx context.Context, r *pb.Req) (*pb.Res, error) { return nil, nil }
`,
  "go/garage.go": `package league

type Garage struct{}

func (g *Garage) Kickoff(ctx context.Context) error { return nil }
func (g *Garage) Whistle(ctx context.Context) error { return nil }
`,
  "go/fake_test.go": `package league

type fakeClub struct{}

func (f *fakeClub) Kickoff(ctx context.Context) error { return nil }
func (f *fakeClub) Whistle(ctx context.Context) error { return nil }
`,
  "java/pom.xml": `<project><groupId>com.example</groupId><artifactId>league</artifactId></project>`,
  "java/league.proto": proto("Player", "Coach"),
  "java/src/main/java/com/example/league/Client.java": `package com.example.league;

public class Client {
  void go(ManagedChannel ch) {
    PlayerServiceGrpc.PlayerServiceBlockingStub m = PlayerServiceGrpc.newBlockingStub(ch);
    m.kickoff(Req.newBuilder().build());
    CoachServiceGrpc.CoachServiceBlockingStub r = CoachServiceGrpc.newBlockingStub(ch);
    r.whistle(Req.newBuilder().build());
  }
}
`,
  "java/src/main/java/com/example/league/PlayerImpl.java": `package com.example.league;

public class PlayerImpl extends PlayerServiceGrpc.PlayerServiceImplBase {
  @Override public void kickoff(Req r, StreamObserver<Res> o) { o.onCompleted(); }
}
`,
  "java/src/main/java/com/example/league/Garage.java": `package com.example.league;

public class Garage {
  public void kickoff(Req r) { }
  public void whistle(Req r) { }
}
`,
  "java/src/test/java/com/example/league/FakePlayer.java": `package com.example.league;

public class FakePlayer {
  public void kickoff(Req r) { }
  public void whistle(Req r) { }
}
`,
  "cs/League.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web"></Project>`,
  "cs/league.proto": proto("Car", "Driver"),
  "cs/Client.cs": `namespace League;

public class Client {
  public void Go(GrpcChannel ch) {
    var m = new CarService.CarServiceClient(ch);
    m.Kickoff(new Req());
    var r = new DriverService.DriverServiceClient(ch);
    r.Whistle(new Req());
  }
}
`,
  "cs/CarImpl.cs": `namespace League;

public class CarImpl : CarService.CarServiceBase {
  public override Task<Res> Kickoff(Req r, ServerCallContext c) => null;
}
`,
  "cs/Garage.cs": `namespace League;

public class Garage {
  public Task<Res> Kickoff(Req r) => null;
  public Task<Res> Whistle(Req r) => null;
}
`,
  "cs/League.Tests/FakeCar.cs": `namespace League;

public class FakeCar {
  public Task<Res> Kickoff(Req r) => null;
  public Task<Res> Whistle(Req r) => null;
}
`,
};

describe("a gRPC rpc's handler is tied to its service", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-grpc-tie-"));
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

  const reached = (lang: string, rpc: string): string[] =>
    summary.symbolLinks
      .filter((l) => l.sourceFile.startsWith(`${lang}/`) && l.sourceSymbol.endsWith(`/${rpc}`))
      .map((l) => `${l.targetFile} ${l.targetSymbol}`)
      .sort();

  it.each([
    ["py", "Kickoff", "py/impl.py MatchServicer.Kickoff"],
    ["go", "Kickoff", "go/server.go server.Kickoff"],
    ["java", "Kickoff", "java/src/main/java/com/example/league/PlayerImpl.java PlayerImpl.kickoff"],
    ["cs", "Kickoff", "cs/CarImpl.cs CarImpl.Kickoff"],
  ])("%s: the rpc %s joins the class extending the generated base only", (lang, rpc, handler) => {
    expect(reached(lang, rpc)).toEqual([handler]);
  });

  it.each(["py", "go", "java", "cs"])("%s: an rpc nothing serves reaches no namesake and no test double", (lang) => {
    expect(reached(lang, "Whistle")).toEqual([]);
  });

  it.each(["py", "go", "java", "cs"])("%s: no client call links into a decoy", (lang) => {
    const decoys = summary.symbolLinks.filter((l) => l.sourceFile.startsWith(`${lang}/`) && l.strategy === "api-route"
      && /(garage|Garage|fake|FakeMatch|test_x|_MatchStub)/i.test(`${l.targetFile} ${l.targetSymbol}`));
    expect(decoys).toEqual([]);
  });
});
