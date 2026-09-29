import { describe, it, expect, vi } from "vitest";
import { extractOpenApiRoutes, extractOpenApiEntities, extractOpenApiRelations } from "./index.js";
import { openapiMeta } from "./meta.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// The core pass asks the registry for the plugin's hooks; answer with this
// plugin's meta directly so the test loads nothing outside the folder.
vi.mock("../../registry.js", () => ({ pluginFor: () => openapiMeta }));

const YAML_SPEC = `openapi: 3.0.1
info:
  title: Users API
basePath: /v1
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        '200': { description: ok }
    post:
      operationId: createUser
  /users/{id}:
    get:
      operationId: getUser
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        orders:
          type: array
          items:
            $ref: '#/components/schemas/Order'
    Order:
      type: object
      properties:
        id: { type: integer }
        total: { type: number }
`;

const JSON_SPEC = JSON.stringify({
  swagger: "2.0",
  paths: {
    "/pets": {
      get: { operationId: "listPets" },
    },
  },
  definitions: {
    Pet: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
  },
}, null, 2);

describe("OpenAPI route extraction", () => {
  it("extracts one api route per path+method, carrying operationId as handler", () => {
    const routes = extractOpenApiRoutes(YAML_SPEC.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /v1/users -> listUsers",
      "POST /v1/users -> createUser",
      "GET /v1/users/{id} -> getUser",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
  });

  it("parses a JSON (Swagger 2) document", () => {
    const routes = extractOpenApiRoutes(JSON_SPEC.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /pets -> listPets",
    ]);
  });
});

describe("OpenAPI schema entities", () => {
  it("turns components.schemas into entity classes with properties", () => {
    const entities = extractOpenApiEntities(YAML_SPEC.split("\n"));
    expect(entities.map((e) => e.name).sort()).toEqual(["Order", "User"]);
    const user = entities.find((e) => e.name === "User")!;
    expect(user.decorators).toEqual(["entity", "openapi"]);
    expect(user.properties.map((p) => p.name)).toEqual(["id", "name", "orders"]);
  });

  it("derives relations from $ref properties (array => one-to-many)", () => {
    const lines = YAML_SPEC.split("\n");
    const rels = extractOpenApiRelations(lines, extractOpenApiEntities(lines));
    expect(rels).toEqual([
      expect.objectContaining({ fromEntity: "User", fromField: "orders", toEntity: "Order", cardinality: "one-to-many" }),
    ]);
  });

  it("reads Swagger 2 `definitions` as entities", () => {
    const entities = extractOpenApiEntities(JSON_SPEC.split("\n"));
    expect(entities.map((e) => e.name)).toEqual(["Pet"]);
  });
});

// ─── Route attribute layer (params / auth / versions) ─────────────────────────

const META_SPEC = `openapi: 3.0.1
info:
  title: Users API
  version: 2.1.0
security:
  - bearerAuth: []
paths:
  /users:
    get:
      operationId: listUsers
      parameters:
        - name: q
          in: query
          schema:
            type: string
        - name: X-Tenant
          in: header
          required: true
          schema:
            type: string
    post:
      operationId: createUser
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateUserRequest'
  /users/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: integer
    get:
      operationId: getUser
    delete:
      operationId: deleteUser
      deprecated: true
      security:
        - oauth2: [admin, write:users]
  /health:
    get:
      operationId: health
      security: []
  /shared:
    post:
      operationId: shared
      parameters:
        - $ref: '#/components/parameters/Page'
      requestBody:
        $ref: '#/components/requestBodies/Bulk'
components:
  parameters:
    Page:
      name: page
      in: query
      schema: { type: integer, format: int32 }
  requestBodies:
    Bulk:
      content:
        application/json:
          schema:
            type: array
            items:
              $ref: '#/components/schemas/CreateUserRequest'
  schemas:
    CreateUserRequest:
      type: object
      required: [name]
      properties:
        name:
          type: string
        email:
          type: string
          format: email
        nickname:
          type: string
          nullable: true
        tags:
          type: array
          items:
            type: string
        address:
          $ref: '#/components/schemas/Address'
    Address:
      type: object
      properties:
        street: { type: string }
    Admin:
      allOf:
        - $ref: '#/components/schemas/Address'
        - type: object
          required:
            - level
          properties:
            level:
              type: integer
              format: int64
`;

describe("OpenAPI route attribute layer", () => {
  const routes = extractOpenApiRoutes(META_SPEC.split("\n"));
  const byOp = (op: string) => routes.find((r) => r.handler === op)!;

  it("binds parameters by their `in`, merging path-item level with operation level", () => {
    expect(byOp("listUsers").params).toEqual([
      { name: "q", type: "string", binding: "query" },
      { name: "X-Tenant", type: "string", binding: "header" },
    ]);
    expect(byOp("getUser").params).toEqual([{ name: "id", type: "integer", binding: "route" }]);
    expect(byOp("deleteUser").params).toEqual([{ name: "id", type: "integer", binding: "route" }]);
  });

  it("turns requestBody into one body param typed by the schema $ref", () => {
    expect(byOp("createUser").params).toEqual([{ name: "body", type: "CreateUserRequest", binding: "body" }]);
  });

  it("resolves $ref parameters and request bodies against components", () => {
    expect(byOp("shared").params).toEqual([
      { name: "page", type: "integer(int32)", binding: "query" },
      { name: "body", type: "CreateUserRequest[]", binding: "body" },
    ]);
  });

  it("applies root security as inherited guards and operation security as own", () => {
    expect(byOp("listUsers").auth).toEqual({
      policies: [], roles: [], schemes: ["bearerAuth"], anonymous: false, inherited: true,
    });
    expect(byOp("listUsers").middleware).toEqual(["bearerAuth"]);
    expect(byOp("deleteUser").auth).toEqual({
      policies: [], roles: ["admin", "write:users"], schemes: ["oauth2"], anonymous: false, inherited: false,
    });
    expect(byOp("deleteUser").middleware).toEqual(["oauth2[admin, write:users]"]);
  });

  it("reads `security: []` as anonymous", () => {
    expect(byOp("health").auth).toMatchObject({ anonymous: true, inherited: false, schemes: [] });
  });

  it("stamps the spec version on every route and marks deprecated operations", () => {
    expect(byOp("listUsers").versions).toEqual(["2.1.0"]);
    expect(byOp("listUsers").deprecatedVersions).toBeUndefined();
    expect(byOp("deleteUser").deprecatedVersions).toEqual(["2.1.0"]);
  });

  it("never marks a spec-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("OpenAPI schema properties for the request-schema pass", () => {
  const entities = extractOpenApiEntities(META_SPEC.split("\n"));
  const req = entities.find((e) => e.name === "CreateUserRequest")!;
  const prop = (n: string) => req.properties.find((p) => p.name === n)!;

  it("keeps JSON type words, formats, array items and nullability in the type text", () => {
    expect(prop("name").type).toBe("string");
    expect(prop("email").type).toBe("string(email)");
    expect(prop("nickname").type).toBe("string?");
    expect(prop("tags").type).toBe("string[]");
    expect(prop("address").type).toBe("Address");
  });

  it("marks the schema-level `required` names on the properties", () => {
    expect(prop("name").isRequired).toBe(true);
    expect(prop("email").isRequired).toBeUndefined();
  });

  it("reads allOf as inheritance plus inline properties", () => {
    const admin = entities.find((e) => e.name === "Admin")!;
    expect(admin.extends).toBe("Address");
    expect(admin.properties).toEqual([
      expect.objectContaining({ name: "level", type: "integer(int64)", isRequired: true }),
    ]);
  });

  it("still relates array $ref properties", () => {
    const lines = YAML_SPEC.split("\n");
    const user = extractOpenApiEntities(lines).find((e) => e.name === "User")!;
    expect(user.properties.find((p) => p.name === "orders")!.type).toBe("Order[]");
    const rels = extractOpenApiRelations(lines, extractOpenApiEntities(lines));
    expect(rels.map((r) => `${r.fromEntity}.${r.fromField}->${r.toEntity}`)).toEqual(["User.orders->Order"]);
  });
});

describe("OpenAPI request-schema hooks", () => {
  it("round-trips the stored type texts to JSON Schema shapes", async () => {
    const { openapiRequestSchema: h } = await import("./request-schema.js");
    expect(h.unwrapNullable("string?")).toEqual({ type: "string", nullable: true });
    expect(h.describeType("integer(int64)")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("boolean")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("Address[]")).toEqual({ kind: "array", element: "Address" });
    expect(h.describeType("object")).toEqual({ kind: "any" });
    expect(h.describeType("Address")).toEqual({ kind: "object", name: "Address" });
    const prop = { name: "x", type: "string", visibility: "public" as const, isStatic: false, isReadonly: false, isRequired: true };
    expect(h.serializedName(prop)).toBe("x");
    expect(h.isSerialized(prop)).toBe(true);
    expect(h.isRequired(prop)).toBe(true);
    expect(h.isRequired({ ...prop, isRequired: undefined })).toBe(false);
  });
});

describe("OpenAPI JSON documents carry the same attribute layer", () => {
  it("reads parameters, security and requestBody from a JSON spec", () => {
    const json = JSON.stringify({
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/pets": {
          post: {
            operationId: "addPet",
            security: [{ apiKey: [] }],
            parameters: [{ name: "dry", in: "query", schema: { type: "boolean" } }],
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
          },
        },
      },
      components: { schemas: { Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } },
    }, null, 2);
    const [route] = extractOpenApiRoutes(json.split("\n"));
    expect(route!.params).toEqual([
      { name: "dry", type: "boolean", binding: "query" },
      { name: "body", type: "Pet", binding: "body" },
    ]);
    expect(route!.auth).toMatchObject({ schemes: ["apiKey"], inherited: false });
    expect(route!.versions).toEqual(["1"]);
    const [pet] = extractOpenApiEntities(json.split("\n"));
    expect(pet!.properties[0]).toMatchObject({ name: "name", type: "string", isRequired: true });
  });
});

describe("OpenAPI request schema through the core pass", () => {
  it("flattens the body schema, its nested $ref, arrays, formats and nullability", () => {
    const lines = META_SPEC.split("\n");
    const analysis = createEmptyAnalysis("openapi.yaml", "openapi");
    analysis.projectId = "root";
    analysis.classes = extractOpenApiEntities(lines);
    const routes = extractOpenApiRoutes(lines).map((r) => ({ ...r, filePath: "openapi.yaml", projectId: "root" }));
    expect(attachRequestSchemas(routes, [analysis])).toBe(2);
    const create = routes.find((r) => r.handler === "createUser") as typeof routes[number] & { requestSchema?: unknown };
    expect(create.requestSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string", format: "email" },
        nickname: { type: "string", nullable: true },
        tags: { type: "array", items: { type: "string" } },
        address: { type: "object", properties: { street: { type: "string" } } },
      },
      required: ["name"],
    });
    const bulk = routes.find((r) => r.handler === "shared") as typeof routes[number] & { requestSchema?: { type?: string } };
    expect(bulk.requestSchema?.type).toBe("array");
  });
});
