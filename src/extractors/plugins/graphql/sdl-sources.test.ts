import { describe, it, expect } from "vitest";
import { extractInlineSdlRoutes } from "../javascript/routes/graphql-sdl-inline.js";
import { extractGqlDocumentCalls, extractGqlOperationCalls } from "../shared/graphql-operations.js";
import { graphqlManifest } from "./manifest.js";

describe("GraphQL schemas and operations outside a .graphql schema file", () => {
  it("reads an Apollo schema written inline as routes at their lines, and calls none of them", () => {
    const src = `import { gql } from "graphql-tag";
export const typeDefs = gql\`
  type User { id: ID! }
  type Query {
    users: [User!]!
    user(id: ID!): User
  }
  type Mutation {
    createUser(name: String!): User
  }
  schema { query: Query mutation: Mutation }
\`;`;
    expect(extractInlineSdlRoutes(src).map((r) => `${r.httpMethod} ${r.path} @${r.line}`)).toEqual([
      "POST /graphql/users @5",
      "POST /graphql/user @6",
      "POST /graphql/createUser @9",
    ]);
    expect(extractGqlOperationCalls(src)).toEqual([]);
    // An operation template is no schema.
    expect(extractInlineSdlRoutes("const Q = gql`query GetUsers { users { id } }`;")).toEqual([]);
  });

  it("reads each operation of a .graphql document as calls of its root fields", () => {
    const doc = `# client operations
fragment UserBits on User { id name }

query GetUser($id: ID!) {
  user(id: $id) { ...UserBits }
}

mutation Rename($id: ID!, $name: String!) {
  renameUser(id: $id, name: $name) { id }
  audit: logEvent(kind: "rename") { ok }
}`;
    expect(extractGqlDocumentCalls(doc).map((c) => `${c.target} @${c.line}`)).toEqual([
      "/graphql/user @4",
      "/graphql/renameUser @8",
      "/graphql/logEvent @8",
    ]);
    // A schema file has no operations.
    expect(extractGqlDocumentCalls("type Query { users: [User] }\nschema { query: Query }")).toEqual([]);
  });

  it("claims Spring's .graphqls schema files", () => {
    expect(graphqlManifest.extensions).toContain(".graphqls");
  });
});
