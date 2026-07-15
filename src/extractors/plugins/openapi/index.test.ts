import { describe, it, expect } from "vitest";
import { extractOpenApiRoutes, extractOpenApiEntities, extractOpenApiRelations } from "./index.js";

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
