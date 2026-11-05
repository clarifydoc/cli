import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { extractHttpClientBases, extractHttpClientRegistrations } from "./http-clients.js";

describe("JS got and a client base built from the environment", () => {
  it("reads a bare got(url) call as a request", async () => {
    const src = `const got = require('got');\nasync function a() { await got('https://league.example.com/api/clubs'); }\n`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const calls = new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(calls.map((c) => c.target)).toEqual(["https://league.example.com/api/clubs"]);
  });

  it("keeps the path of `process.env.API_URL + '/api'` and the env origin as the client's base", async () => {
    const src = `const api = axios.create({ baseURL: process.env.API_URL + '/api' });\n`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    expect(extractHttpClientBases(tree, src)).toEqual({ api: "/api" });
    expect(extractHttpClientRegistrations(tree, src)).toMatchObject([{ client: "api", base: { kind: "env", key: "API_URL" } }]);
  });

  it("joins a literal origin and a path written as two strings", async () => {
    const src = `const api = axios.create({ baseURL: "https://league.example.com" + "/api/" });\n`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    expect(extractHttpClientBases(tree, src)).toEqual({ api: "/api" });
  });
});
