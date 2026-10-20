import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { resolveRtkHooks } from "./rtk-query.js";
import { createEmptyAnalysis, type DataSourceInfo, type FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

async function callsOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

const SLICE = `import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: "/api/" }),
  endpoints: (build) => ({
    getPosts: build.query({ query: () => "posts" }),
    getPost: build.query({ query: (id) => \`/posts/\${id}\` }),
    addPost: build.mutation({ query: (body) => ({ url: "posts", method: "POST", body }) }),
    deletePost: build.mutation({ query(id) { return { url: \`posts/\${id}\`, method: "delete" }; } }),
    custom: build.query({ queryFn: () => ({ data: 1 }) }),
  }),
});
export const { useGetPostsQuery, useAddPostMutation } = api;`;

describe("RTK Query", () => {
  it("each endpoint is one api-call at the slice's base, tagged with its name", async () => {
    expect((await callsOf(SLICE)).map((d) => `${d.name} ${d.target} ${d.endpoint}`)).toEqual([
      "GET /api/posts getPosts",
      "GET /api/posts/${id} getPost",
      "POST /api/posts addPost",
      "DELETE /api/posts/${id} deletePost",
    ]);
  });

  it("a component's generated hooks and initiate() name the endpoint they call", async () => {
    const calls = await callsOf(`import { useGetPostsQuery, useLazyGetPostQuery, useAddPostMutation, api } from "./api";
import { useAppDispatch } from "./hooks";
export function Posts() {
  useGetPostsQuery();
  useLazyGetPostQuery();
  useAddPostMutation();
  useAppDispatch();
  useCustomQuery();
  dispatch(api.endpoints.getPosts.initiate());
}`);
    expect(calls.map((d) => `${d.name} ${d.target} ${d.endpoint}`)).toEqual([
      "useGetPostsQuery null getPosts",
      "useLazyGetPostQuery null getPost",
      "useAddPostMutation null addPost",
      "api null getPosts",
    ]);
  });

  it("the project pass gives a hook call its endpoint's method and URL, from the slice it imports", async () => {
    const slice: FileAnalysis = { ...createEmptyAnalysis("src/api.ts", "typescript"), dataSources: await callsOf(SLICE) };
    const calls = [
      { kind: "api-call" as const, name: "useAddPostMutation", target: null, line: 3, calls: [], endpoint: "addPost", filePath: "src/Posts.tsx" },
      { kind: "api-call" as const, name: "useNopeQuery", target: null, line: 4, calls: [], endpoint: "nope", filePath: "src/Posts.tsx" },
    ];
    const ctx = { importIndex: { localFor: (_f: string, n: string) => (n.startsWith("use") ? "src/api.ts" : null), sourceFor: () => null, namespacesFor: () => [] } } as unknown as ProjectContext;
    expect(resolveRtkHooks(calls, [slice], ctx)).toBe(1);
    expect(calls.map((c) => `${c.name} ${c.target}`)).toEqual(["POST /api/posts", "useNopeQuery null"]);
  });

  it("drops a use…Mutation the project declares itself — a TanStack composable, no generated hook", () => {
    const queries: FileAnalysis = {
      ...createEmptyAnalysis("src/TrainingQueries.ts", "typescript"),
      functions: [{ name: "useUpdateTrainingMutation", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 3, endLine: 8 }],
    };
    const calls = [
      { kind: "api-call" as const, name: "useUpdateTrainingMutation", target: null, line: 9, calls: [], endpoint: "updateTraining", filePath: "src/TrainingInfo.vue" },
      { kind: "api-call" as const, name: "get", target: "/api/x", line: 12, calls: [], filePath: "src/TrainingInfo.vue" },
    ];
    const ctx = { importIndex: { localFor: () => "src/TrainingQueries.ts", sourceFor: () => null, namespacesFor: () => [] } } as unknown as ProjectContext;
    expect(resolveRtkHooks(calls, [queries], ctx)).toBe(0);
    expect(calls.map((c) => c.name)).toEqual(["get"]);
  });
});
