import { describe, it, expect, vi } from "vitest";
import { extractGraphqlRoutes, extractGraphqlEntities, extractGraphqlRelations } from "./index.js";
import { graphqlMeta } from "./meta.js";
import { attachRequestSchemas } from "../../../core/request-schemas.js";
import { createEmptyAnalysis } from "../../../types/analysis.js";

// The core pass asks the registry for the plugin's hooks; answer with this
// plugin's meta directly so the test loads nothing outside the folder.
vi.mock("../../registry.js", () => ({ pluginFor: () => graphqlMeta }));

const SCHEMA = `# The data model
type User {
  id: ID!
  name: String!
  orders: [Order!]!
}

type Order {
  id: ID!
  total: Float!
  buyer: User!
}

type Query {
  users: [User!]!
  user(id: ID!): User
}

type Mutation {
  createUser(input: CreateUserInput!): User
}

input CreateUserInput {
  name: String!
}
`;

describe("GraphQL schema route extraction", () => {
  it("turns each Query/Mutation field into a synthetic /graphql/<field> POST route", () => {
    const routes = extractGraphqlRoutes(SCHEMA.split("\n"));
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "POST /graphql/users -> users",
      "POST /graphql/user -> user",
      "POST /graphql/createUser -> createUser",
    ]);
    expect(routes.every((r) => r.kind === "api")).toBe(true);
  });
});

describe("GraphQL schema entities", () => {
  it("turns object/input types (not root types) into entities", () => {
    const entities = extractGraphqlEntities(SCHEMA.split("\n"));
    expect(entities.map((e) => e.name).sort()).toEqual(["CreateUserInput", "Order", "User"]);
    expect(entities.find((e) => e.name === "User")!.decorators).toEqual(["entity", "graphql"]);
  });

  it("derives relations from object-typed fields (list => one-to-many)", () => {
    const lines = SCHEMA.split("\n");
    const rels = extractGraphqlRelations(lines, extractGraphqlEntities(lines));
    expect(rels).toContainEqual(
      expect.objectContaining({ fromEntity: "User", fromField: "orders", toEntity: "Order", cardinality: "one-to-many" }),
    );
    expect(rels).toContainEqual(
      expect.objectContaining({ fromEntity: "Order", fromField: "buyer", toEntity: "User", cardinality: "many-to-one" }),
    );
  });

  it("does not treat scalar fields (ID/String/Float) as relations", () => {
    const lines = SCHEMA.split("\n");
    const rels = extractGraphqlRelations(lines, extractGraphqlEntities(lines));
    expect(rels.some((r) => r.toEntity === "String" || r.toEntity === "ID")).toBe(false);
  });
});

// ─── Route attribute layer (params / auth / deprecation) + request schema ─────

const META_SCHEMA = `scalar DateTime

type Query {
  users(limit: Int = 20, search: String): [User!]!
  user(
    id: ID!
  ): User
  legacyUsers: [User!]! @deprecated(reason: "Use users")
}

type Mutation @isAuthenticated {
  createUser(input: CreateUserInput!): User
  deleteUser(id: ID!): Boolean! @auth(requires: ADMIN)
  importUsers(rows: [CreateUserInput!]!): Int @hasRole(role: "importer") @hasScope(scope: "users:write")
  ping: String @public
}

type User {
  id: ID!
  name: String!
  createdAt: DateTime
}

input AddressInput {
  street: String!
  zip: String
}

input CreateUserInput {
  name: String!
  email: String
  address: AddressInput
  tags: [String!]
  meta: JSON
}
`;

describe("GraphQL route attribute layer", () => {
  const routes = extractGraphqlRoutes(META_SCHEMA.split("\n"));
  const byName = (n: string) => routes.find((r) => r.handler === n)!;

  it("keeps field arguments as body-bound params with the type text as written", () => {
    expect(byName("users").params).toEqual([
      { name: "limit", type: "Int", binding: "body" },
      { name: "search", type: "String", binding: "body" },
    ]);
    expect(byName("createUser").params).toEqual([{ name: "input", type: "CreateUserInput!", binding: "body" }]);
  });

  it("joins a wrapped argument list onto its field and never reads the inner lines as fields", () => {
    expect(byName("user").params).toEqual([{ name: "id", type: "ID!", binding: "body" }]);
    expect(routes.map((r) => r.handler)).not.toContain("id");
    expect(byName("user").line).toBe(5);
  });

  it("inherits a root-type directive and adds field directives as own guards", () => {
    expect(byName("createUser").auth).toEqual({
      policies: ["isAuthenticated"], roles: [], schemes: [], anonymous: false, inherited: true,
    });
    expect(byName("deleteUser").auth).toEqual({
      policies: ["isAuthenticated"], roles: ["ADMIN"], schemes: [], anonymous: false, inherited: false,
    });
    expect(byName("deleteUser").middleware).toEqual(["@isAuthenticated", "@auth(requires: ADMIN)"]);
    expect(byName("importUsers").auth).toMatchObject({ roles: ["importer"], policies: ["isAuthenticated", "scope:users:write"] });
    expect(byName("ping").auth).toMatchObject({ anonymous: true });
    expect(byName("users").auth).toBeUndefined();
  });

  it("records @deprecated as a middleware entry, never as a version", () => {
    expect(byName("legacyUsers").middleware).toEqual(['@deprecated(reason: "Use users")']);
    expect(byName("legacyUsers").deprecatedVersions).toBeUndefined();
    expect(byName("legacyUsers").versions).toBeUndefined();
  });

  it("never marks a schema-declared binding as inferred", () => {
    expect(routes.flatMap((r) => r.params ?? []).some((p) => p.inferred)).toBe(false);
  });
});

describe("GraphQL type properties for the request-schema pass", () => {
  const entities = extractGraphqlEntities(META_SCHEMA.split("\n"));
  const input = entities.find((e) => e.name === "CreateUserInput")!;
  const prop = (n: string) => input.properties.find((p) => p.name === n)!;

  it("keeps the raw type text and marks `!` fields required", () => {
    expect(prop("name")).toMatchObject({ type: "String!", isRequired: true });
    expect(prop("email")).toMatchObject({ type: "String" });
    expect(prop("email").isRequired).toBeUndefined();
    expect(prop("tags").type).toBe("[String!]");
    expect(prop("address").type).toBe("AddressInput");
  });

  it("still derives relations from the stripped type name", () => {
    const lines = SCHEMA.split("\n");
    const rels = extractGraphqlRelations(lines, extractGraphqlEntities(lines));
    expect(rels.map((r) => `${r.fromEntity}.${r.fromField}->${r.toEntity}`)).toEqual([
      "User.orders->Order", "Order.buyer->User",
    ]);
  });
});

describe("GraphQL request-schema hooks", () => {
  it("inverts nullability on `!` and maps scalars, lists and custom scalars", async () => {
    const { graphqlRequestSchema: h } = await import("./request-schema.js");
    expect(h.unwrapNullable("String!")).toEqual({ type: "String", nullable: false });
    expect(h.unwrapNullable("String")).toEqual({ type: "String", nullable: true });
    expect(h.describeType("ID")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("Int")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(h.describeType("Float")).toEqual({ kind: "scalar", schema: { type: "number" } });
    expect(h.describeType("Boolean")).toEqual({ kind: "scalar", schema: { type: "boolean" } });
    expect(h.describeType("DateTime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("JSON")).toEqual({ kind: "any" });
    expect(h.describeType("[String!]")).toEqual({ kind: "array", element: "String!" });
    expect(h.describeType("AddressInput")).toEqual({ kind: "object", name: "AddressInput" });
  });

  it("flattens a mutation input through the core pass", () => {
    const lines = META_SCHEMA.split("\n");
    const analysis = createEmptyAnalysis("schema.graphql", "graphql");
    analysis.projectId = "root";
    analysis.classes = extractGraphqlEntities(lines);
    const routes = extractGraphqlRoutes(lines).map((r) => ({ ...r, filePath: "schema.graphql", projectId: "root" }));
    attachRequestSchemas(routes, [analysis]);
    const create = routes.find((r) => r.handler === "createUser") as typeof routes[number] & { requestSchema?: unknown };
    expect(create.requestSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string", nullable: true },
        address: {
          type: "object",
          properties: { street: { type: "string" }, zip: { type: "string", nullable: true } },
          required: ["street"],
          nullable: true,
        },
        tags: { type: "array", items: { type: "string" }, nullable: true },
        meta: { nullable: true },
      },
      required: ["name"],
    });
  });
});
