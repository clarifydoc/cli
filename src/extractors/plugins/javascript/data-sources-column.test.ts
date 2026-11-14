import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo } from "../../../types/analysis.js";

async function callsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

describe("a column on api calls", () => {
  it("points a fetch at the column its call starts, not just the line", async () => {
    const calls = await callsOf(`fetch('/api/clubs');
function load() {
    fetch('/api/players');
}`);
    expect(calls.map((d) => [d.line, d.column])).toEqual([
      [1, 0], // at the line's start: column 0
      [3, 4], // indented: the column is the indent width
    ]);
  });

  it("points an RTK Query endpoint at its build.query call", async () => {
    const calls = await callsOf(`import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),
  endpoints: (build) => ({
    getClubs: build.query({ query: () => "clubs" }),
  }),
});`);
    expect(calls.map((d) => [d.line, d.column, d.endpoint])).toEqual([
      // `    getClubs: build.query(…)` — the call starts at column 14.
      [5, 14, "getClubs"],
    ]);
  });

  it("points a gql operation at the column its tag starts", async () => {
    const calls = await callsOf(`import { useQuery } from "@apollo/client";
export function Clubs() {
  const { data } = useQuery(gql\`
    query Clubs { clubs { id } }
  \`);
}`);
    expect(calls.map((d) => [d.line, d.column, d.target])).toEqual([
      // `  const { data } = useQuery(gql\`` — the tag starts at column 28.
      [3, 28, "/graphql/clubs"],
    ]);
  });

  it("counts characters, not bytes, after a non-ASCII prefix (tree-sitter and gql paths agree)", async () => {
    const calls = await callsOf(`const é = 1; fetch('/api/clubs');
export function Kit() {
  const x = "🚗"; useQuery(gql\`
    query Clubs { clubs { id } }
  \`);
}`);
    expect(calls.map((d) => [d.line, d.column]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      // `const é = 1; ` is 13 characters (é is one UTF-16 unit, two bytes).
      [1, 13],
      // `  const x = "🚗"; useQuery(` — the tag starts at column 27 (🚗 is two units).
      [3, 27],
    ]);
  });
});
