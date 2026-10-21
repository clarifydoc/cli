import { describe, it, expect, vi } from "vitest";
import { extractOpenApiRoutes, extractOpenApiEntities, extractOpenApiRelations } from "./index.js";
import { isOpenApiDocument, openapiMeta } from "./meta.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// The core pass asks the registry for the plugin's hooks; answer with this
// plugin's meta directly so the test loads nothing outside the folder.
vi.mock("../../registry.js", () => ({ pluginFor: () => openapiMeta }));

const YAML_SPEC = `openapi: 3.0.1
info:
  title: Players API
basePath: /v1
paths:
  /players:
    get:
      operationId: listPlayers
      responses:
        '200': { description: ok }
    post:
      operationId: createPlayer
  /players/{id}:
    get:
      operationId: getPlayer
components:
  schemas:
    Player:
      type: object
      properties:
        id:
          type: integer
        name:
          type: string
        cars:
          type: array
          items:
            $ref: '#/components/schemas/Car'
    Car:
      type: object
      properties:
        id: { type: integer }
        total: { type: number }
`;

const JSON_SPEC = JSON.stringify({
  swagger: "2.0",
  paths: {
    "/vehicles": {
      get: { operationId: "listVehicles" },
    },
  },
  definitions: {
    Vehicle: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
  },
}, null, 2);

describe("OpenAPI route extraction", () => {
  it("extracts one api route per path+method, carrying operationId as handler", () => {
    const routes = extractOpenApiRoutes(YAML_SPEC.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /v1/players -> listPlayers",
      "POST /v1/players -> createPlayer",
      "GET /v1/players/{id} -> getPlayer",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
  });

  it("parses a JSON (Swagger 2) document", () => {
    const routes = extractOpenApiRoutes(JSON_SPEC.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /vehicles -> listVehicles",
    ]);
  });
});

describe("OpenAPI schema entities", () => {
  it("turns components.schemas into entity classes with properties", () => {
    const entities = extractOpenApiEntities(YAML_SPEC.split("\n"));
    expect(entities.map((e) => e.name).sort()).toEqual(["Car", "Player"]);
    const player = entities.find((e) => e.name === "Player")!;
    expect(player.decorators).toEqual(["entity", "openapi"]);
    expect(player.properties.map((p) => p.name)).toEqual(["id", "name", "cars"]);
  });

  it("derives relations from $ref properties (array => one-to-many)", () => {
    const lines = YAML_SPEC.split("\n");
    const rels = extractOpenApiRelations(lines, extractOpenApiEntities(lines));
    expect(rels).toEqual([
      expect.objectContaining({ fromEntity: "Player", fromField: "cars", toEntity: "Car", cardinality: "one-to-many" }),
    ]);
  });

  it("reads Swagger 2 `definitions` as entities", () => {
    const entities = extractOpenApiEntities(JSON_SPEC.split("\n"));
    expect(entities.map((e) => e.name)).toEqual(["Vehicle"]);
  });
});

// ─── Route attribute layer (params / auth / versions) ─────────────────────────

const META_SPEC = `openapi: 3.0.1
info:
  title: Players API
  version: 2.1.0
security:
  - bearerAuth: []
paths:
  /players:
    get:
      operationId: listPlayers
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
      operationId: createPlayer
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreatePlayerRequest'
  /players/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: integer
    get:
      operationId: getPlayer
    delete:
      operationId: deletePlayer
      deprecated: true
      security:
        - oauth2: [admin, write:players]
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
              $ref: '#/components/schemas/CreatePlayerRequest'
  schemas:
    CreatePlayerRequest:
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
    expect(byOp("listPlayers").params).toEqual([
      { name: "q", type: "string", binding: "query" },
      { name: "X-Tenant", type: "string", binding: "header" },
    ]);
    expect(byOp("getPlayer").params).toEqual([{ name: "id", type: "integer", binding: "route" }]);
    expect(byOp("deletePlayer").params).toEqual([{ name: "id", type: "integer", binding: "route" }]);
  });

  it("turns requestBody into one body param typed by the schema $ref", () => {
    expect(byOp("createPlayer").params).toEqual([{ name: "body", type: "CreatePlayerRequest", binding: "body" }]);
  });

  it("resolves $ref parameters and request bodies against components", () => {
    expect(byOp("shared").params).toEqual([
      { name: "page", type: "integer(int32)", binding: "query" },
      { name: "body", type: "CreatePlayerRequest[]", binding: "body" },
    ]);
  });

  it("applies root security as inherited guards and operation security as own", () => {
    expect(byOp("listPlayers").auth).toEqual({
      policies: [], roles: [], schemes: ["bearerAuth"], anonymous: false, inherited: true,
    });
    expect(byOp("listPlayers").middleware).toEqual(["bearerAuth"]);
    expect(byOp("deletePlayer").auth).toEqual({
      policies: [], roles: ["admin", "write:players"], schemes: ["oauth2"], anonymous: false, inherited: false,
    });
    expect(byOp("deletePlayer").middleware).toEqual(["oauth2[admin, write:players]"]);
  });

  it("reads `security: []` as anonymous", () => {
    expect(byOp("health").auth).toMatchObject({ anonymous: true, inherited: false, schemes: [] });
  });

  it("stamps the spec version on every route and marks deprecated operations", () => {
    expect(byOp("listPlayers").versions).toEqual(["2.1.0"]);
    expect(byOp("listPlayers").deprecatedVersions).toBeUndefined();
    expect(byOp("deletePlayer").deprecatedVersions).toEqual(["2.1.0"]);
  });

  it("never marks a spec-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("OpenAPI schema properties for the request-schema pass", () => {
  const entities = extractOpenApiEntities(META_SPEC.split("\n"));
  const req = entities.find((e) => e.name === "CreatePlayerRequest")!;
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
    const player = extractOpenApiEntities(lines).find((e) => e.name === "Player")!;
    expect(player.properties.find((p) => p.name === "cars")!.type).toBe("Car[]");
    const rels = extractOpenApiRelations(lines, extractOpenApiEntities(lines));
    expect(rels.map((r) => `${r.fromEntity}.${r.fromField}->${r.toEntity}`)).toEqual(["Player.cars->Car"]);
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
        "/vehicles": {
          post: {
            operationId: "addVehicle",
            security: [{ apiKey: [] }],
            parameters: [{ name: "dry", in: "query", schema: { type: "boolean" } }],
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Vehicle" } } } },
          },
        },
      },
      components: { schemas: { Vehicle: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } },
    }, null, 2);
    const [route] = extractOpenApiRoutes(json.split("\n"));
    expect(route!.params).toEqual([
      { name: "dry", type: "boolean", binding: "query" },
      { name: "body", type: "Vehicle", binding: "body" },
    ]);
    expect(route!.auth).toMatchObject({ schemes: ["apiKey"], inherited: false });
    expect(route!.versions).toEqual(["1"]);
    const [vehicle] = extractOpenApiEntities(json.split("\n"));
    expect(vehicle!.properties[0]).toMatchObject({ name: "name", type: "string", isRequired: true });
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
    const create = routes.find((r) => r.handler === "createPlayer") as typeof routes[number] & { requestSchema?: unknown };
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

describe("OpenAPI document sniff", () => {
  const filler = Array.from({ length: 300 }, (_, i) => `"Club${i}": { "type": "object", "properties": { "name": { "type": "string" } } }`).join(",\n");
  it("finds the version key of a sorted-key JSON document past the head", () => {
    const doc = `{\n"components": { "schemas": {\n${filler}\n} },\n"info": { "title": "League" },\n"openapi": "3.1.0",\n"paths": {}\n}`;
    expect(doc.indexOf('"openapi"')).toBeGreaterThan(8192);
    expect(isOpenApiDocument(doc)).toBe(true);
  });
  it("finds a YAML document's top-level version key past the head, never an indented one", () => {
    const yamlFiller = Array.from({ length: 400 }, (_, i) => `    Club${i}:\n      type: object`).join("\n");
    expect(isOpenApiDocument(`components:\n  schemas:\n${yamlFiller}\nopenapi: 3.0.3\npaths: {}\n`)).toBe(true);
    expect(isOpenApiDocument(`components:\n  schemas:\n${yamlFiller}\n  openapi: 3.0.3\n`)).toBe(false);
  });
  it("rejects a JSON document that names the key only below the top level", () => {
    const doc = `{\n"clubs": [\n${filler}\n],\n"meta": { "openapi": "3.0.0" }\n}`;
    expect(isOpenApiDocument(doc)).toBe(false);
    expect(isOpenApiDocument(`{\n"clubs": [\n${filler}\n],\n"note": "openapi"\n}`)).toBe(false);
  });
});
