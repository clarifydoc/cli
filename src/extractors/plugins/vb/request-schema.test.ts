import { describe, it, expect } from "vitest";
import { vbSpec } from "./index.js";
import { camelCase, readVbType, splitVbAttributes, vbNamedArgs, vbRequestSchema as h } from "./request-schema.js";

const classes = (src: string) => vbSpec.extractClasses!(src.split("\n"), []);

describe("VB request-schema hooks", () => {
  it("camelCase follows System.Text.Json's policy", () => {
    expect(camelCase("Name")).toBe("name");
    expect(camelCase("ID")).toBe("id");
    expect(camelCase("URLValue")).toBe("urlValue");
    expect(camelCase("already")).toBe("already");
  });

  it("reads VB types with generic arguments, arrays and nullables", () => {
    expect(readVbType("As List(Of String)", 2)).toEqual({ type: "List(Of String)", end: 18 });
    expect(readVbType("As Dictionary(Of String, List(Of Integer)) = Nothing", 2)!.type).toBe("Dictionary(Of String, List(Of Integer))");
    expect(readVbType("As Integer?", 2)!.type).toBe("Integer?");
    expect(readVbType("As String()", 2)!.type).toBe("String()");
    expect(readVbType("As System.Guid", 2)!.type).toBe("System.Guid");
  });

  it("classifies scalars (case-insensitively), collections, maps, nullables and unknown objects", () => {
    expect(h.unwrapNullable("Integer?")).toEqual({ type: "Integer", nullable: true });
    expect(h.unwrapNullable("Nullable(Of Guid)")).toEqual({ type: "Guid", nullable: true });
    expect(h.describeType("String")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("integer")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int32" } });
    expect(h.describeType("Long")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("Decimal")).toEqual({ kind: "scalar", schema: { type: "number", format: "double" } });
    expect(h.describeType("Date")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("System.Guid")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("List(Of String)")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("IEnumerable(Of Address)")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("String()")).toEqual({ kind: "array", element: "String" });
    expect(h.describeType("Dictionary(Of String, List(Of Integer))")).toEqual({ kind: "map", value: "List(Of Integer)" });
    expect(h.describeType("Object")).toEqual({ kind: "any" });
    expect(h.describeType("Models.Address")).toEqual({ kind: "object", name: "Models.Address" });
  });

  it("reads wire names and required/ignored markers from attributes, split from one <…> list", () => {
    const p = (decorators: string[], extra: Record<string, unknown> = {}) => ({
      name: "UserName", type: "String", visibility: "public" as const, isStatic: false, isReadonly: false, decorators, ...extra,
    });
    expect(h.serializedName(p(['JsonProperty("user_name")']))).toBe("user_name");
    expect(h.serializedName(p(['JsonPropertyName("user_name")']))).toBe("user_name");
    expect(h.serializedName(p(['DataMember(Name:="user_name")']))).toBe("user_name");
    expect(h.serializedName(p(['Required, JsonProperty("user_name")']))).toBe("user_name");
    expect(h.serializedName(p([]))).toBe("userName");
    expect(h.isRequired(p(["Required"]))).toBe(true);
    expect(h.isRequired(p(['Required(ErrorMessage:="x"), StringLength(50)']))).toBe(true);
    expect(h.isRequired(p(["RequiredIf"]))).toBe(false);
    expect(h.isSerialized(p(["JsonIgnore"]))).toBe(false);
    expect(h.isSerialized(p([], { visibility: "private" }))).toBe(false);
    expect(h.isSerialized(p([], { isStatic: true }))).toBe(false);
    expect(h.isSerialized(p([]))).toBe(true);
  });

  it("splits attribute lists and reads named arguments", () => {
    expect(splitVbAttributes('<Route("a, b"), Authorize(Roles:="Admin, Editor")>')).toEqual(['Route("a, b")', 'Authorize(Roles:="Admin, Editor")']);
    expect(vbNamedArgs('Authorize(Roles:="Admin", Policy:=NameOf(Policies.Edit))')).toEqual(new Map([["Roles", "Admin"], ["Policy", "Policies.Edit"]]));
  });
});

describe("VB handler parameter binding (project-level join)", () => {
  it("binds simple types from the query, complex ones from the body, and injected tokens as services", () => {
    const route = { path: "/api/users/{id}", httpMethod: "PUT", kind: "api" as const, handler: "Put", calls: [], middleware: [], line: 1 };
    expect(h.bindParam!({ name: "page", type: "Integer", defaultValue: null }, route)).toBe("query");
    expect(h.bindParam!({ name: "ids", type: "List(Of Integer)", defaultValue: null }, route)).toBe("query");
    expect(h.bindParam!({ name: "request", type: "CreateUserRequest", defaultValue: null }, route)).toBe("body");
    expect(h.bindParam!({ name: "token", type: "CancellationToken", defaultValue: null }, route)).toBe("services");
  });
});

describe("VB properties", () => {
  it("takes auto-properties with own-line and inline attributes, generics, nullables and inheritance", () => {
    const found = classes(
      [
        "Public Class UserRequestBase",
        "    <Required>",
        "    Public Property Email As String",
        "End Class",
        "",
        "Public Class CreateUserRequest",
        "    Inherits UserRequestBase",
        "",
        "    <Required> _",
        '    <JsonProperty("user_name")>',
        "    Public Property Name As String",
        "    <StringLength(20)> Public Property Role As String = \"user\"",
        "    Public Property Tags As List(Of String)",
        "    Public Property Age As Integer?",
        "    Public Shared Property Counter As Integer",
        "    Private Property Secret As String",
        "    Public ReadOnly Property Display() As String",
        "        Get",
        "            Return Name",
        "        End Get",
        "    End Property",
        "End Class",
      ].join("\n"),
    );
    const base = found.find((c) => c.name === "UserRequestBase")!;
    expect(base.properties.map((p) => [p.name, p.type, p.decorators])).toEqual([["Email", "String", ["Required"]]]);
    const req = found.find((c) => c.name === "CreateUserRequest")!;
    expect(req.extends).toBe("UserRequestBase");
    expect(req.properties.map((p) => [p.name, p.type, p.visibility, p.isStatic, p.decorators ?? []])).toEqual([
      ["Name", "String", "public", false, ["Required", 'JsonProperty("user_name")']],
      ["Role", "String", "public", false, ["StringLength(20)"]],
      ["Tags", "List(Of String)", "public", false, []],
      ["Age", "Integer?", "public", false, []],
      ["Counter", "Integer", "public", true, []],
      ["Secret", "String", "private", false, []],
      ["Display", "String", "public", false, []],
    ]);
  });

  it("still takes fields, now with their generic arguments", () => {
    const [cls] = classes(["Public Class UserService", "    Private ReadOnly _users As New List(Of User)", "    Private _nextId As Integer = 1", "End Class"].join("\n"));
    expect(cls.properties.map((p) => [p.name, p.type, p.isReadonly])).toEqual([
      ["_users", "List(Of User)", true],
      ["_nextId", "Integer", false],
    ]);
  });
});
