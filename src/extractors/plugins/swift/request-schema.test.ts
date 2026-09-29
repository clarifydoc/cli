import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { swiftSpec } from "./index.js";
import { extractSwiftRequestAccess, swiftRequestSchema as h } from "./request-schema.js";

const classes = (src: string) => swiftSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), swiftSpec);

describe("Swift request-schema hooks", () => {
  it("classifies scalars, sugar collections, generics, optionals and unknown objects", () => {
    expect(h.unwrapNullable("Date?")).toEqual({ type: "Date", nullable: true });
    expect(h.unwrapNullable("Optional<UUID>")).toEqual({ type: "UUID", nullable: true });
    expect(h.describeType("String")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("Int")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("Date")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("UUID")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("[String]")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("[[Int]]")).toEqual({ kind: "array", element: "[Int]" });
    expect(h.describeType("Array<Owner>")).toEqual({ kind: "array", element: "Owner" });
    expect(h.describeType("[String: [Int]]")).toEqual({ kind: "map", value: "[Int]" });
    expect(h.describeType("Dictionary<String, Any>")).toEqual({ kind: "map", value: "Any" });
    expect(h.describeType("AnyCodable")).toEqual({ kind: "any" });
    expect(h.describeType("Owner")).toEqual({ kind: "object", name: "Owner" });
  });

  it("reads Fluent field keys, skips relations and honours the required marker", () => {
    const p = (decorators: string[], extra: Record<string, unknown> = {}) => ({
      name: "createdAt", type: "Date", visibility: "public" as const, isStatic: false, isReadonly: false, decorators, ...extra,
    });
    expect(h.serializedName(p(['Field(key: "created_at")']))).toBe("created_at");
    expect(h.serializedName(p(["ID(key: .id)"]))).toBe("createdAt");
    expect(h.serializedName(p([]))).toBe("createdAt");
    expect(h.isSerialized(p(['Children(for: \\.$todo)']))).toBe(false);
    expect(h.isSerialized(p(['Parent(key: "owner_id")']))).toBe(true);
    expect(h.isSerialized(p([], { isStatic: true }))).toBe(false);
    expect(h.isRequired(p([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(p([]))).toBe(false);
  });

  it("binds a Request parameter to services and says nothing about the rest", () => {
    const route = { path: "/todos", httpMethod: "POST", kind: "api" as const, handler: "create", calls: [], middleware: [], line: 1 };
    expect(h.bindParam!({ name: "req", type: "Request", defaultValue: null }, route)).toBe("services");
    expect(h.bindParam!({ name: "id", type: "UUID", defaultValue: null }, route)).toBeNull();
  });
});

describe("Swift properties with attributes", () => {
  it("takes inline and own-line property wrappers as decorators and marks required fields", () => {
    const [cls] = classes(
      [
        "struct CreateTodo: Content {",
        "    @Field(key: \"title\")",
        "    var title: String",
        "    @OptionalField(key: \"due_at\") var due: Date?",
        "    var tags: [String] = []",
        "    static let schema = \"todos\"",
        "    let owner: Owner",
        "}",
      ].join("\n"),
    );
    expect(cls.properties.map((p) => [p.name, p.type, p.decorators ?? [], p.isRequired ?? false])).toEqual([
      ["title", "String", ['Field(key: "title")'], true],
      ["due", "Date?", ['OptionalField(key: "due_at")'], false],
      ["tags", "[String]", [], false],
      ["owner", "Owner", [], true],
    ]);
  });

  it("attaches own-line attributes to functions and classes too", () => {
    const [fn] = functions("@discardableResult\nfunc save() -> Bool {\n}");
    expect(fn.decorators).toEqual(["discardableResult"]);
  });
});

describe("Swift request access", () => {
  it("reads body, query, route, header and auth access off the request", () => {
    const body = [
      "let input = try req.content.decode(CreateTodo.self)",
      "let filter = try req.query.decode(TodoFilter.self)",
      'let q = req.query["q"]',
      'let page = req.query[Int.self, at: "page"]',
      'let size = req.query.get(Int.self, at: "size")',
      'guard let id = req.parameters.get("id", as: UUID.self) else { throw Abort(.notFound) }',
      'let slug = try req.parameters.require("slug")',
      'let tenant = req.headers["X-Tenant"]',
      'let lang = req.headers.first(name: "Accept-Language")',
      "let token = req.headers.bearerAuthorization",
      "let user = try req.auth.require(User.self)",
    ];
    expect(extractSwiftRequestAccess(body, { name: "create", params: [{ name: "req", type: "Request", defaultValue: null }] })).toEqual([
      { name: "input", type: "CreateTodo", binding: "body" },
      { name: "filter", type: "TodoFilter", binding: "query" },
      { name: "q", type: null, binding: "query" },
      { name: "page", type: "Int", binding: "query" },
      { name: "size", type: "Int", binding: "query" },
      { name: "id", type: "UUID", binding: "route" },
      { name: "slug", type: null, binding: "route" },
      { name: "X-Tenant", type: null, binding: "header" },
      { name: "Accept-Language", type: null, binding: "header" },
      { name: "Authorization", type: null, binding: "header" },
      { name: "auth", type: "User", binding: "services" },
    ]);
  });

  it("lands on FunctionInfo.requestAccess for a handler, under the request's declared name", () => {
    const [fn] = functions(
      [
        "func create(request: Request) async throws -> Todo {",
        "    let todo = try request.content.decode(Todo.self)",
        "    return todo",
        "}",
      ].join("\n"),
    );
    expect(fn.requestAccess).toEqual([{ name: "todo", type: "Todo", binding: "body" }]);
    expect(fn.params).toEqual([{ name: "request", type: "Request", defaultValue: null }]);
  });

  it("parses labelled, unlabelled, inout and defaulted parameters", () => {
    const [fn] = functions('func f(_ id: UUID, for name: String = "x", inout buf: [UInt8], req: Request) {\n}');
    expect(fn.params).toEqual([
      { name: "id", type: "UUID", defaultValue: null },
      { name: "name", type: "String", defaultValue: '"x"' },
      { name: "buf", type: "[UInt8]", defaultValue: null },
      { name: "req", type: "Request", defaultValue: null },
    ]);
  });
});
