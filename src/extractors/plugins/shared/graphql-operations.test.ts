import { describe, it, expect } from "vitest";
import { parseGqlOperationRootFields, extractGqlOperationCalls } from "./graphql-operations.js";

describe("parseGqlOperationRootFields", () => {
  it("reads root fields of a named query with variables", () => {
    expect(parseGqlOperationRootFields("query GetUsers($id: ID!) { user(id: $id) { id name } }"))
      .toEqual(["user"]);
  });

  it("reads anonymous shorthand queries", () => {
    expect(parseGqlOperationRootFields("{ users { id } me { name } }")).toEqual(["users", "me"]);
  });

  it("reads the operation even when fragments precede it", () => {
    const doc = `fragment UserFields on User { id name }
      query GetUsers { users { ...UserFields } }`;
    expect(parseGqlOperationRootFields(doc)).toEqual(["users"]);
  });

  it("ignores alias labels, keeping the real field", () => {
    expect(parseGqlOperationRootFields("query { admins: users { id } }")).toEqual(["users"]);
  });

  it("returns nothing for a fragment-only document", () => {
    expect(parseGqlOperationRootFields("fragment F on User { id name }")).toEqual([]);
  });
});

describe("extractGqlOperationCalls", () => {
  it("emits one POST api-call per root field targeting /graphql/<field>", () => {
    const src = `
      import { gql } from '@apollo/client';
      const GET_USERS = gql\`query GetUsers { users { id } }\`;
      const CREATE = gql\`mutation { createUser(input: {}) { id } }\`;
    `;
    const calls = extractGqlOperationCalls(src);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual([
      "post /graphql/users",
      "post /graphql/createUser",
    ]);
    expect(calls.every((c) => c.kind === "api-call")).toBe(true);
  });

  it("ignores fragment templates", () => {
    const src = "const F = gql`fragment UserFields on User { id name }`;";
    expect(extractGqlOperationCalls(src)).toEqual([]);
  });
});
