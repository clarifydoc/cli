import { describe, it, expect } from "vitest";
import { extractVaporRoutes } from "./routes.js";
import { extractSwiftDataSources } from "./data-sources.js";

/** Swift produced ZERO routes and ZERO data sources before this. */
const lines = (src: string) => src.split("\n");

describe("Vapor routes", () => {
  it("joins comma-separated path segments and grouped(...) prefixes", () => {
    const routes = extractVaporRoutes(lines(`
func routes(_ app: Application) throws {
    app.get("health") { req in "OK" }

    let api = app.grouped("api")
    let drills = api.grouped("drills")
    drills.get(use: index)
    drills.get(":id", use: show)
    drills.post(use: create)
    api.delete("sessions", ":id", use: logout)
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /health -> null",
      "GET /api/drills -> index",
      "GET /api/drills/:id -> show",
      "POST /api/drills -> create",
      "DELETE /api/sessions/:id -> logout",
    ]);
  });

  it("handles app.on(.VERB, ...) and ignores non-builder receivers", () => {
    const routes = extractVaporRoutes(lines(`
app.on(.PUT, "players", ":id") { req in ... }
let res = try await req.client.get("https://api.example.com/items")
dict.get("key")
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["PUT /players/:id"]);
  });
});

describe("Swift data sources", () => {
  it("captures Fluent queries (entity from model type), HTTP clients and env", () => {
    const s = extractSwiftDataSources(lines(`
let drills = try await Drill.query(on: req.db).filter(\\.$done == false).all()
let player = try await Player.find(req.parameters.get("id"), on: req.db)
try await drill.save(on: req.db)
let resp = try await client.get("https://api.example.com/items")
let key = Environment.get("API_KEY")
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "Drill")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "Player")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.target === "drill" && d.name === "Fluent: save")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.target === "https://api.example.com/items")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_KEY")).toBe(true);
  });

  it("extracts tables from raw SQL strings", () => {
    const s = extractSwiftDataSources(lines(`
let rows = try await sql.raw("SELECT id, name FROM drivers WHERE active = true").all()
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "drivers")).toBe(true);
  });
});

describe("Vapor route guards and params", () => {
  it("inherits authenticator/guard middleware from grouped(...) as auth", () => {
    const routes = extractVaporRoutes(lines(`
let drills = app.grouped("api", "drills")
let protected = drills.grouped(PlayerToken.authenticator(), Player.guardMiddleware())
drills.get(":id", use: DrillController.show)
protected.post(use: DrillController.create)
protected.delete(":id", use: DrillController.remove)
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/drills/:id",
      "POST /api/drills",
      "DELETE /api/drills/:id",
    ]);
    expect(routes[0]!.auth).toBeUndefined();
    expect(routes[0]!.middleware).toEqual([]);
    expect(routes[1]!.middleware).toEqual(["PlayerToken.authenticator()", "Player.guardMiddleware()"]);
    expect(routes[1]!.auth).toEqual({
      policies: ["Player.guardMiddleware"],
      roles: [],
      schemes: ["PlayerToken.authenticator"],
      anonymous: false,
      inherited: true,
    });
    // A `use:` handler lives elsewhere: params come from the project-level join.
    expect(routes[1]!.params).toBeUndefined();
  });

  it("reads an inline grouped(...) chain as the route's own guard and keeps plain middleware as text", () => {
    const routes = extractVaporRoutes(lines(`
app.grouped(JWTMiddleware()).grouped("me").get("profile") { req in
    let player = try req.auth.require(Player.self)
    return player
}
app.grouped(RateLimiter(perMinute: 10)).get("open") { req in "OK" }
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /me/profile", "GET /open"]);
    expect(routes[0]!.auth).toEqual({ policies: [], roles: [], schemes: ["JWTMiddleware"], anonymous: false, inherited: false });
    expect(routes[0]!.middleware).toEqual(["JWTMiddleware()"]);
    expect(routes[0]!.params).toEqual([{ name: "auth", type: "Player", binding: "services", inferred: true }]);
    expect(routes[1]!.auth).toBeUndefined();
    expect(routes[1]!.middleware).toEqual(["RateLimiter(perMinute: 10)"]);
  });

  it("derives route and query params for a trailing-closure handler from its path and body", () => {
    const routes = extractVaporRoutes(lines(`
app.get("players", ":id", "games") { req in
    let id = req.parameters.get("id")
    let q = req.query["q"]
    return []
}
`));
    expect(routes[0]!.params).toEqual([
      { name: "id", type: null, binding: "route", inferred: true },
      { name: "q", type: null, binding: "query", inferred: true },
    ]);
  });
});

describe("Alamofire's method", () => {
  it("reads the method AF.request states, GET when it states none", async () => {
    const { extractSwiftDataSources } = await import("./data-sources.js");
    const rows = extractSwiftDataSources([
      'AF.request("https://api.shop.test/cars", method: .post, parameters: car)',
      'AF.request("https://api.shop.test/cars/1", method: HTTPMethod.delete)',
      'AF.request("https://api.shop.test/cars")',
    ]).filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`);
    expect(rows).toEqual(["POST https://api.shop.test/cars", "DELETE https://api.shop.test/cars/1", "GET https://api.shop.test/cars"]);
  });
});
