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
    let todos = api.grouped("todos")
    todos.get(use: index)
    todos.get(":id", use: show)
    todos.post(use: create)
    api.delete("sessions", ":id", use: logout)
}
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /health -> null",
      "GET /api/todos -> index",
      "GET /api/todos/:id -> show",
      "POST /api/todos -> create",
      "DELETE /api/sessions/:id -> logout",
    ]);
  });

  it("handles app.on(.VERB, ...) and ignores non-builder receivers", () => {
    const routes = extractVaporRoutes(lines(`
app.on(.PUT, "users", ":id") { req in ... }
let res = try await req.client.get("https://api.example.com/items")
dict.get("key")
`));
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["PUT /users/:id"]);
  });
});

describe("Swift data sources", () => {
  it("captures Fluent queries (entity from model type), HTTP clients and env", () => {
    const s = extractSwiftDataSources(lines(`
let todos = try await Todo.query(on: req.db).filter(\\.$done == false).all()
let user = try await User.find(req.parameters.get("id"), on: req.db)
try await todo.save(on: req.db)
let resp = try await client.get("https://api.example.com/items")
let key = Environment.get("API_KEY")
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "Todo")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.entity === "User")).toBe(true);
    expect(s.some((d) => d.kind === "database" && d.target === "todo" && d.name === "Fluent: save")).toBe(true);
    expect(s.some((d) => d.kind === "api-call" && d.target === "https://api.example.com/items")).toBe(true);
    expect(s.some((d) => d.kind === "env" && d.target === "API_KEY")).toBe(true);
  });

  it("extracts tables from raw SQL strings", () => {
    const s = extractSwiftDataSources(lines(`
let rows = try await sql.raw("SELECT id, name FROM customers WHERE active = true").all()
`));
    expect(s.some((d) => d.kind === "database" && d.entity === "customers")).toBe(true);
  });
});
