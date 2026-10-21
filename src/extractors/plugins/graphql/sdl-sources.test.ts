import { describe, it, expect } from "vitest";
import { extractInlineSdlRoutes } from "../javascript/routes/graphql-sdl-inline.js";
import { extractGqlDocumentCalls, extractGqlOperationCalls } from "../shared/graphql-operations.js";
import { graphqlManifest } from "./manifest.js";

describe("GraphQL schemas and operations outside a .graphql schema file", () => {
  it("reads an Apollo schema written inline as routes at their lines, and calls none of them", () => {
    const src = `import { gql } from "graphql-tag";
export const typeDefs = gql\`
  type Player { id: ID! }
  type Query {
    players: [Player!]!
    player(id: ID!): Player
  }
  type Mutation {
    createPlayer(name: String!): Player
  }
  schema { query: Query mutation: Mutation }
\`;`;
    expect(extractInlineSdlRoutes(src).map((r) => `${r.httpMethod} ${r.path} @${r.line}`)).toEqual([
      "POST /graphql/players @5",
      "POST /graphql/player @6",
      "POST /graphql/createPlayer @9",
    ]);
    expect(extractGqlOperationCalls(src)).toEqual([]);
    // An operation template is no schema.
    expect(extractInlineSdlRoutes("const Q = gql`query GetPlayers { players { id } }`;")).toEqual([]);
  });

  it("reads each operation of a .graphql document as calls of its root fields", () => {
    const doc = `# client operations
fragment PlayerBits on Player { id name }

query GetPlayer($id: ID!) {
  player(id: $id) { ...PlayerBits }
}

mutation Rename($id: ID!, $name: String!) {
  renamePlayer(id: $id, name: $name) { id }
  audit: logEvent(kind: "rename") { ok }
}`;
    expect(extractGqlDocumentCalls(doc).map((c) => `${c.target} @${c.line}`)).toEqual([
      "/graphql/player @4",
      "/graphql/renamePlayer @8",
      "/graphql/logEvent @8",
    ]);
    // A schema file has no operations.
    expect(extractGqlDocumentCalls("type Query { players: [Player] }\nschema { query: Query }")).toEqual([]);
  });

  it("claims Spring's .graphqls schema files", () => {
    expect(graphqlManifest.extensions).toContain(".graphqls");
  });
});
