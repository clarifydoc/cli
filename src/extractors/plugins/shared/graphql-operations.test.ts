import { describe, it, expect } from "vitest";
import { parseGqlOperationRootFields, extractGqlOperationCalls, extractGqlDocumentCalls } from "./graphql-operations.js";

describe("parseGqlOperationRootFields", () => {
  it("reads root fields of a named query with variables", () => {
    expect(parseGqlOperationRootFields("query GetPlayers($id: ID!) { player(id: $id) { id name } }"))
      .toEqual(["player"]);
  });

  it("reads anonymous shorthand queries", () => {
    expect(parseGqlOperationRootFields("{ players { id } me { name } }")).toEqual(["players", "me"]);
  });

  it("reads the operation even when fragments precede it", () => {
    const doc = `fragment PlayerFields on Player { id name }
      query GetPlayers { players { ...PlayerFields } }`;
    expect(parseGqlOperationRootFields(doc)).toEqual(["players"]);
  });

  it("ignores alias labels, keeping the real field", () => {
    expect(parseGqlOperationRootFields("query { admins: players { id } }")).toEqual(["players"]);
  });

  it("returns nothing for a fragment-only document", () => {
    expect(parseGqlOperationRootFields("fragment F on Player { id name }")).toEqual([]);
  });
});

describe("extractGqlOperationCalls", () => {
  it("emits one POST api-call per root field targeting /graphql/<field>", () => {
    const src = `
      import { gql } from '@apollo/client';
      const GET_PLAYERS = gql\`query GetPlayers { players { id } }\`;
      const CREATE = gql\`mutation { createPlayer(input: {}) { id } }\`;
    `;
    const calls = extractGqlOperationCalls(src);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual([
      "post /graphql/players",
      "post /graphql/createPlayer",
    ]);
    expect(calls.every((c) => c.kind === "api-call")).toBe(true);
  });

  it("ignores fragment templates", () => {
    const src = "const F = gql`fragment PlayerFields on Player { id name }`;";
    expect(extractGqlOperationCalls(src)).toEqual([]);
  });
});

describe("extractGqlDocumentCalls", () => {
  it("states the column of each operation's keyword, after a non-ASCII description and a comment", () => {
    const doc = `"""é🚗 clubs"""\n# a comment\nquery A { clubs { id } } query B { player { id } }\n  mutation C { relegate { id } }`;
    expect(extractGqlDocumentCalls(doc).map((d) => [d.target, d.line, d.column])).toEqual([
      ["/graphql/clubs", 3, 0],
      ["/graphql/player", 3, 25],
      ["/graphql/relegate", 4, 2],
    ]);
  });
});
