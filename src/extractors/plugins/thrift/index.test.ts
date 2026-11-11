import { describe, expect, it } from "vitest";
import "../../registry.js";
import { extractThriftClasses, extractThriftRoutes, normalizeType } from "./index.js";
import { thriftRequestSchema } from "./request-schema.js";
import { goThriftStub, jsThriftStub, jvmThriftStub, pythonThriftStub, thriftServiceOf } from "../shared/thrift-stubs.js";
import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";

const IDL = `namespace * league.any
namespace java com.example.league // the java one qualifies
# a hash comment: service Fake { void nope() }
typedef list<Player> Squad
const i32 MAX = 10
enum Position { KEEPER = 1, DEFENDER, STRIKER = 5 }
union Result { 1: Club club, 2: string message }
exception NotFound { 1: required string message }
struct Club {
  1: required string name;
  2: optional i32 founded
  3: list<map<string, Player>> squad = [],
}
service ClubService {
  /** Look a club up. */
  Club getClub(1: string id, 2: optional bool full) throws (1: NotFound nf) (deprecated = "yes"),
  map<string, list<Club>> byLeague(1: string league);
  oneway void ping()
}
`;

describe("thrift services", () => {
  it("gives every method a POST row at the java namespace's service path", () => {
    const routes = extractThriftRoutes(IDL.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler} L${r.line}`)).toEqual([
      "POST /com.example.league.ClubService/getClub getClub L16",
      "POST /com.example.league.ClubService/byLeague byLeague L17",
      "POST /com.example.league.ClubService/ping ping L18",
    ]);
    expect(routes[0]!.contract).toEqual({ type: "com.example.league.ClubService", method: "getClub" });
    expect(routes[0]!.params).toEqual([{ name: "args", type: "ClubService_getClub_args", binding: "body" }]);
  });

  it("reads structs, unions, exceptions, enums and argument structs as classes", () => {
    const classes = extractThriftClasses(IDL.split("\n"));
    const by = (n: string): ClassInfo => classes.find((c) => c.name === n)!;
    expect(by("Club").properties.map((p) => `${p.name}:${p.type}${p.isRequired ? "!" : ""}`)).toEqual(["name:string!", "founded:i32", "squad:map<string,Player>[]"]);
    expect(by("Result").decorators).toEqual(["thrift-union"]);
    expect(by("NotFound").decorators).toEqual(["thrift-exception"]);
    expect(by("Position").properties.map((p) => p.name)).toEqual(["KEEPER", "DEFENDER", "STRIKER"]);
    expect(by("ClubService_getClub_args").properties.map((p) => `${p.name}:${p.type}`)).toEqual(["id:string", "full:bool"]);
    expect(by("ClubService_ping_args").properties).toEqual([]);
    expect(classes.some((c) => c.name === "Fake")).toBe(false);
  });

  it("normalizes container types and describes them as JSON", () => {
    expect(normalizeType("list<set<i32>>")).toBe("i32[][]");
    expect(thriftRequestSchema.describeType("map<string,Player>")).toEqual({ kind: "map", value: "Player" });
    expect(thriftRequestSchema.describeType("shared.Player[]")).toEqual({ kind: "array", element: "shared.Player" });
    expect(thriftRequestSchema.describeType("i64")).toMatchObject({ kind: "scalar" });
  });
});

describe("thrift generated names", () => {
  const file = (source?: string) => ({ imports: source ? [{ source }] : [] }) as unknown as FileAnalysis;
  it("reads each language's stub and a class implementing the Iface", () => {
    expect(jvmThriftStub("new ClubService.Client()", file("org.apache.thrift.TException"))).toEqual({ service: "ClubService", certain: true });
    expect(jvmThriftStub("ClubService.Client", file())).toEqual({ service: "ClubService", certain: false });
    expect(jvmThriftStub("Client", file())).toBeNull();
    expect(pythonThriftStub("ClubService.Client()", file("thrift.protocol"))).toEqual({ service: "ClubService", certain: true });
    expect(jsThriftStub("new ClubService.Client()", file("thrift"))).toEqual({ service: "ClubService", certain: true });
    expect(goThriftStub("league.NewClubServiceClientFactory()", file("github.com/apache/thrift/lib/go/thrift"))).toEqual({ service: "ClubService", certain: true });
    expect(goThriftStub("http.Client", file())).toBeNull();
    const cls = (extra: Partial<ClassInfo>) => ({ extends: null, implements: [], ...extra }) as ClassInfo;
    expect(thriftServiceOf(cls({ implements: ["ClubService.Iface"] }))).toBe("ClubService");
    expect(thriftServiceOf(cls({ extends: "league.ClubService.Iface" }))).toBe("ClubService");
    expect(thriftServiceOf(cls({ implements: ["Runnable"] }))).toBeNull();
  });
});

describe("string literals in Thrift", () => {
  const lines = (s: string) => s.split("\n");

  it("does not read a field out of a default value", () => {
    const [club] = extractThriftClasses(lines(`struct Club {\n  1: string note = "2: i32 fake",\n  3: i32 founded\n}`));
    expect(club!.properties.map((p) => p.name)).toEqual(["note", "founded"]);
  });

  it("keeps an escaped quote inside its string", () => {
    const routes = extractThriftRoutes(lines(`service ClubService {\n  string say(1: string a = "he said \\"hi\\" ) {"),\n  void ping()\n}`));
    expect(routes.map((r) => r.path)).toEqual(["/ClubService/say", "/ClubService/ping"]);
  });

  it("does not let a lone quote swallow the rest of the file", () => {
    const routes = extractThriftRoutes(lines(`service ClubService {\n  void ping() ( note = it's )\n  void pong()\n}`));
    expect(routes.map((r) => r.path)).toEqual(["/ClubService/ping", "/ClubService/pong"]);
  });

  it("reads a Go stub type only in a file importing the Thrift runtime", () => {
    const file = (source: string) => ({ imports: [{ source }] }) as unknown as FileAnalysis;
    expect(goThriftStub("ClubServiceClient", file("net/http"))).toBeNull();
    expect(goThriftStub("ClubServiceClient", file("github.com/apache/thrift/lib/go/thrift"))).toEqual({ service: "ClubService", certain: true });
    expect(jsThriftStub("thrift.createClient(ClubService,conn)", file("thrift"))).toEqual({ service: "ClubService", certain: true });
  });
});
