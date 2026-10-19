import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { askTool, listTools, parseAskArgs, toolNameOf } from "./ask.js";

const analysisDir = resolve("test-output/sample-backend");
const config = { projectRoot: resolve("test-fixtures/sample-backend"), analysisDir, allowAnalyze: false, allowColdStart: false };

describe("parseAskArgs", () => {
  it("merges a JSON object with key=value pairs, reading JSON-shaped values as JSON", () => {
    expect(parseAskArgs('{"limit":5,"path":"/x"}', ["path=/api/users", "detail=true", "kinds=[\"route\"]", "q=GET /a"])).toEqual({
      limit: 5,
      path: "/api/users",
      detail: true,
      kinds: ["route"],
      q: "GET /a",
    });
    expect(() => parseAskArgs("[1]", [])).toThrow(/JSON object/);
    expect(() => parseAskArgs(undefined, ["novalue"])).toThrow(/key=value/);
  });
  it("names a tool with or without its prefix", () => {
    expect(toolNameOf("blast-radius")).toBe("clarifydoc_blast_radius");
    expect(toolNameOf("clarifydoc_routes")).toBe("clarifydoc_routes");
  });
});

describe.skipIf(!existsSync(join(analysisDir, "project-summary.json")))("askTool", () => {
  it("answers through the server's own tools/call, read-only", async () => {
    const r = await askTool(config, "routes", { path: "/api/users", method: "POST" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/POST \/api\/users \(routes\/users\.ts:20\)/);
  });
  it("refuses an unknown tool and bad arguments as errors", async () => {
    const unknown = await askTool(config, "nope", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Tools: status, search, routes/);
    const bad = await askTool(config, "routes", { limit: "many" });
    expect(bad.isError).toBe(true);
  });
  it("lists every tool with its arguments", () => {
    const tools = listTools(config);
    expect(tools.find((t) => t.name === "clarifydoc_contract")?.args).toContain("path");
    expect(tools.length).toBeGreaterThan(10);
  });
});
