import { describe, it, expect, beforeAll } from "vitest";
import { loadAllPlugins } from "../extractors/registry.js";
import { attachRequestSchemas } from "./request-schemas.js";
import type { ClassInfo, FileAnalysis, JsonSchemaNode, PropertyInfo, RouteInfo } from "../types/analysis.js";

/**
 * The join a real-repo review asked for: route → body parameter → class →
 * flattened, camel-cased, typed JSON schema. Classes are hand-built here (the
 * C# extractor's own tests cover reading them from source); what is under
 * test is the recursion, the inheritance walk and the plugin mapping.
 */

beforeAll(async () => {
  await loadAllPlugins();
});

const prop = (name: string, type: string, extra: Partial<PropertyInfo> = {}): PropertyInfo => ({
  name,
  type,
  visibility: "public",
  isStatic: false,
  isReadonly: false,
  ...extra,
});

const cls = (name: string, properties: PropertyInfo[], ext: string | null = null): ClassInfo => ({
  name,
  extends: ext,
  implements: [],
  decorators: [],
  methods: [],
  properties,
  isExported: true,
  line: 1,
  endLine: 10,
});

const file = (filePath: string, classes: ClassInfo[], projectId = "api"): FileAnalysis =>
  ({ filePath, language: "csharp", projectId, classes, routes: [], functions: [], imports: [], exports: [],
     dataSources: [], dataMutations: [], subComponents: [], templateTree: [], interactiveElements: [],
     events: [], typeReferences: [], complexities: [], securityIssues: [], frameworks: [] }) as unknown as FileAnalysis;

const bodyRoute = (
  type: string,
  projectId = "api",
): RouteInfo & { filePath: string; projectId: string; requestSchema?: JsonSchemaNode } => ({
  path: "/api/users",
  httpMethod: "POST",
  kind: "api",
  handler: "Create",
  calls: [],
  middleware: [],
  line: 12,
  filePath: "Controllers/UsersController.cs",
  projectId,
  params: [{ name: "dto", type, binding: "body" }],
});

describe("attachRequestSchemas", () => {
  it("flattens inheritance, camel-cases, honours [JsonPropertyName]/[Required]/required and maps C# types", () => {
    const analyses = [
      file("Controllers/UsersController.cs", []),
      file("Models/User.cs", [
        cls("AuditedRequest", [prop("RequestedBy", "Guid?"), prop("RequestedAt", "DateTime")]),
        cls("CreateUserDto", [
          prop("Name", "string", { decorators: ["Required"], isRequired: true }),
          prop("Email", "string", { decorators: ['JsonPropertyName("email_address")'] }),
          prop("Roles", "List<string>"),
          prop("HomeAddress", "Address?"),
          prop("Attributes", "Dictionary<string, int>"),
          prop("Secret", "string", { decorators: ["JsonIgnore"] }),
          prop("Counter", "int", { isStatic: true }),
          prop("_cache", "string", { visibility: "private" }),
          prop("PrimaryRole", "UserRole"),
        ], "AuditedRequest"),
        cls("Address", [prop("Street", "string"), prop("PostalCode", "int?")]),
      ]),
    ];
    const route = bodyRoute("CreateUserDto");
    expect(attachRequestSchemas([route], analyses)).toBe(1);
    expect(route.requestSchema).toEqual({
      type: "object",
      properties: {
        requestedBy: { type: "string", format: "uuid", nullable: true },
        requestedAt: { type: "string", format: "date-time" },
        name: { type: "string" },
        email_address: { type: "string" },
        roles: { type: "array", items: { type: "string" } },
        homeAddress: {
          type: "object",
          properties: { street: { type: "string" }, postalCode: { type: "integer", format: "int32", nullable: true } },
          nullable: true,
        },
        attributes: { type: "object", additionalProperties: { type: "integer", format: "int32" } },
        primaryRole: { $ref: "UserRole" }, // enum: not a class the extractor knows → by name
      },
      required: ["name"],
    });
  });

  it("prefers the class in the route's own sub-project and leaves a cross-project ambiguity as a $ref", () => {
    const analyses = [
      file("Controllers/UsersController.cs", [], "api"),
      file("api/Dto.cs", [cls("Dto", [prop("A", "int")])], "api"),
      file("other/Dto.cs", [cls("Dto", [prop("B", "int")])], "other"),
      file("x/Shared.cs", [cls("Shared", [prop("S", "int")])], "x"),
      file("y/Shared.cs", [cls("Shared", [prop("T", "int")])], "y"),
    ];
    const own = bodyRoute("Dto");
    const foreign = bodyRoute("Shared");
    expect(attachRequestSchemas([own, foreign], analyses)).toBe(1);
    expect(Object.keys(own.requestSchema!.properties!)).toEqual(["a"]);
    expect(foreign.requestSchema).toBeUndefined();
  });

  it("cuts cycles and depth with a $ref instead of recursing forever", () => {
    const analyses = [
      file("Controllers/UsersController.cs", []),
      file("Node.cs", [cls("Node", [prop("Value", "int"), prop("Children", "List<Node>")])]),
    ];
    const route = bodyRoute("Node");
    attachRequestSchemas([route], analyses);
    expect(route.requestSchema).toEqual({
      type: "object",
      properties: { value: { type: "integer", format: "int32" }, children: { type: "array", items: { $ref: "Node" } } },
    });
  });

  it("builds an object from field-level body params when no whole-body type is known", () => {
    const analyses = [file("Controllers/UsersController.cs", [])];
    const route = { ...bodyRoute("x"), params: [
      { name: "name", type: "string", binding: "body" as const, inferred: true },
      { name: "age", type: "int?", binding: "body" as const, inferred: true },
      { name: "note", type: null, binding: "body" as const, inferred: true },
      { name: "q", type: "string", binding: "query" as const },
    ] };
    expect(attachRequestSchemas([route], analyses)).toBe(1);
    expect(route.requestSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer", format: "int32", nullable: true }, note: {} },
    });
    // A single scalar body FIELD is a property, never the whole schema.
    const scalar = { ...bodyRoute("x"), params: [{ name: "name", type: "string", binding: "body" as const }] };
    attachRequestSchemas([scalar], analyses);
    expect(scalar.requestSchema).toEqual({ type: "object", properties: { name: { type: "string" } } });
    // Only the opaque whole-body marker: nothing to say.
    const opaque = { ...bodyRoute("x"), params: [{ name: "body", type: null, binding: "body" as const }] };
    expect(attachRequestSchemas([opaque], analyses)).toBe(0);
  });

  it("renders an enum class as a string enum of its members", () => {
    const role = cls("UserRole", [prop("Guest", "UserRole"), prop("Admin", "UserRole")]);
    role.kind = "enum";
    const analyses = [file("Controllers/UsersController.cs", []), file("Dto.cs", [cls("Dto", [prop("Role", "UserRole")]), role])];
    const route = bodyRoute("Dto");
    attachRequestSchemas([route], analyses);
    expect(route.requestSchema).toEqual({ type: "object", properties: { role: { type: "string", enum: ["Guest", "Admin"] } } });
  });

  it("skips routes without a body parameter, non-api routes, and languages without hooks", () => {
    const analyses = [file("Controllers/UsersController.cs", []), file("Dto.cs", [cls("Dto", [prop("A", "int")])])];
    const noBody = { ...bodyRoute("Dto"), params: [{ name: "id", type: "int", binding: "route" as const }] };
    const frontend = { ...bodyRoute("Dto"), kind: "frontend" as const };
    const ruby = { ...bodyRoute("Dto"), filePath: "app/c.rb" };
    analyses.push({ ...file("app/c.rb", []), language: "ruby" } as FileAnalysis);
    expect(attachRequestSchemas([noBody, frontend, ruby], analyses)).toBe(0);
  });
});

import { attachHandlerParams } from "./request-schemas.js";
import type { FunctionInfo } from "../types/analysis.js";

describe("attachHandlerParams — routes whose handler is declared elsewhere", () => {
  const fn = (name: string, params: Array<[string, string | null]>, extra: Partial<FunctionInfo> = {}): FunctionInfo => ({
    name,
    params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })),
    returnType: null,
    isAsync: false,
    isExported: true,
    decorators: [],
    calls: [],
    line: 1,
    endLine: 5,
    ...extra,
  });
  const apiRoute = (handler: string | null, path: string, filePath = "routes.ts", projectId = "api") => ({
    path,
    httpMethod: "GET",
    kind: "api" as const,
    handler,
    calls: [],
    middleware: [],
    line: 3,
    filePath,
    projectId,
  });
  const analysisWith = (filePath: string, functions: FunctionInfo[], classes: ClassInfo[] = [], projectId = "api") =>
    ({ ...file(filePath, classes, projectId), functions }) as FileAnalysis;

  it("bare handler in the same file: path tokens → route, body reads from requestAccess", () => {
    const handler = fn("getUser", [["req", null], ["res", null]], {
      requestAccess: [{ name: "body", type: null, binding: "body" }, { name: "q", type: null, binding: "query" }],
    });
    const route = apiRoute("getUser", "/users/:id");
    const filled = attachHandlerParams([route], [analysisWith("routes.ts", [handler])]);
    expect(filled).toBe(1);
    expect(route).toMatchObject({
      params: [
        { name: "req", type: null, binding: null },
        { name: "res", type: null, binding: null },
        { name: "body", type: null, binding: "body", inferred: true },
        { name: "q", type: null, binding: "query", inferred: true },
        { name: "id", type: null, binding: "route", inferred: true }, // the template's own token
      ],
    });
  });

  it("`Class#method` resolves to the class method in another file of the same sub-project", () => {
    const ctl = cls("OrderController", []);
    ctl.methods = [fn("store", [["request", "StoreOrderRequest"], ["id", "int"]], {
      requestAccess: [{ name: "note", type: null, binding: "body" }],
    })];
    const route = apiRoute("OrderController#store", "/orders/{id}", "routes/api.php");
    attachHandlerParams([route], [analysisWith("routes/api.php", []), analysisWith("app/OrderController.php", [], [ctl])]);
    expect((route as { params?: unknown }).params).toEqual([
      { name: "request", type: "StoreOrderRequest", binding: null },
      { name: "id", type: "int", binding: "route", inferred: true },
      { name: "note", type: null, binding: "body", inferred: true },
    ]);
  });

  it("`pkg.Func` resolves to the unique leaf name in the sub-project; an ambiguous name is left alone", () => {
    const route = apiRoute("handler.ListProducts", "/products", "main.go");
    const dup = apiRoute("svc.Dup", "/dup", "main.go");
    attachHandlerParams(
      [route, dup],
      [
        analysisWith("main.go", []),
        analysisWith("handler/products.go", [fn("ListProducts", [["c", "*gin.Context"]], { requestAccess: [{ name: "page", type: null, binding: "query" }] }), fn("Dup", [["db", "*sql.DB"]])]),
        analysisWith("other/dup.go", [fn("Dup", [["x", "int"]])]),
      ],
    );
    expect((route as { params?: unknown[] }).params).toHaveLength(2);
    expect((dup as { params?: unknown }).params).toBeUndefined();
  });

  it("breaks a shared leaf name by the qualifier's directory, then by handler shape", () => {
    const byDir = apiRoute("handler.ListProducts", "/products", "main.go");
    const byShape = apiRoute("h.ListUsers", "/users", "main.go");
    attachHandlerParams(
      [byDir, byShape],
      [
        analysisWith("main.go", []),
        analysisWith("handler/product_handler.go", [
          fn("ListProducts", [["c", "*gin.Context"]], { requestAccess: [{ name: "q", type: null, binding: "query" }] }),
          fn("ListUsers", [["c", "*gin.Context"]], { requestAccess: [{ name: "page", type: null, binding: "query" }] }),
        ]),
        analysisWith("store/product_store.go", [fn("ListProducts", [["db", "*sql.DB"]]), fn("ListUsers", [["limit", "int"]])]),
      ],
    );
    expect((byDir as { params?: Array<{ name: string }> }).params?.map((p) => p.name)).toEqual(["c", "q"]);
    expect((byShape as { params?: Array<{ name: string }> }).params?.map((p) => p.name)).toEqual(["c", "page"]);
  });

  it("leaves routes that already carry params, frontend routes and unresolvable handlers untouched", () => {
    const declared = { ...apiRoute("x", "/x"), params: [{ name: "id", type: "int", binding: "route" as const }] };
    const frontend = { ...apiRoute("x", "/x"), kind: "frontend" as const };
    const missing = apiRoute("nope", "/x");
    const noHandler = apiRoute(null, "/x");
    expect(attachHandlerParams([declared, frontend, missing, noHandler], [analysisWith("routes.ts", [fn("x", [["req", null]])])])).toBe(0);
    expect(declared.params).toHaveLength(1);
  });
});
