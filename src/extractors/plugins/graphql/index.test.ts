import { describe, it, expect } from "vitest";
import { extractGraphqlRoutes, extractGraphqlEntities, extractGraphqlRelations } from "./index.js";

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
