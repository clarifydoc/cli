import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { askTool, listTools, parseAskArgs, toolNameOf } from "./ask.js";

const analysisDir = resolve("test-output/sample-backend");
const config = { projectRoot: resolve("test-fixtures/sample-backend"), analysisDir, allowAnalyze: false, allowColdStart: false };

describe("parseAskArgs", () => {
  it("merges a JSON object with key=value pairs, reading JSON-shaped values as JSON", () => {
    expect(parseAskArgs('{"limit":5,"path":"/x"}', ["path=/api/players", "detail=true", "kinds=[\"route\"]", "q=GET /a"])).toEqual({
      limit: 5,
      path: "/api/players",
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
    const r = await askTool(config, "routes", { path: "/api/players", method: "POST" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/POST \/api\/players \(routes\/players\.ts:20\)/);
  });
  it("refuses an unknown tool and bad arguments as errors", async () => {
    const unknown = await askTool(config, "nope", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Tools: status, search, routes/);
    const bad = await askTool(config, "routes", { limit: "many" });
    expect(bad.isError).toBe(true);
  });
  it("projects an edit not made yet: proposed content, nothing written", async () => {
    const { readFile } = await import("fs/promises");
    const file = join(config.projectRoot, "services", "playerService.ts");
    const now = await readFile(file, "utf8");
    const content = now.replace("export async function getPlayerById(id: number) {", "export async function getPlayerById(id: number, withGames: boolean) {");
    const r = await askTool(config, "impact", { proposed: [{ file: "services/playerService.ts", content }] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/base: proposed edit/);
    expect(r.text).toMatch(/\*\*breaking\*\* `getPlayerById` 1 → 2 required parameters/);
    expect(await readFile(file, "utf8")).toBe(now);
    const bad = await askTool(config, "impact", { proposed: [{ file: "../etc/passwd", content: "" }] });
    expect(bad.isError).toBe(true);
  });

  it("draws a function's control flow, and slices backward from a line", async () => {
    const pick = await askTool(config, "control_flow", { file: "middleware/auth.ts" });
    expect(pick.text).toMatch(/has 2 functions[\s\S]*requireAuth \(lines 9-22, complexity 3\)/);
    const drawn = await askTool(config, "control_flow", { file: "middleware/auth.ts", function: "requireAuth" });
    expect(drawn.text).toMatch(/```mermaid\nflowchart TD/);
    const slice = await askTool(config, "control_flow", { file: "middleware/auth.ts", slice: 18 });
    expect(slice.text).toMatch(/middleware\/auth\.ts:11 {2}if \(!header\?\.startsWith\('Bearer '\)\) \{ {2}\(control\)/);
    expect((await askTool(config, "control_flow", { file: "middleware/auth.ts", function: "nope" })).text).toMatch(/No function in middleware\/auth\.ts matches "nope"/);
  });

  it("lists every tool with its arguments", () => {
    const tools = listTools(config);
    expect(tools.find((t) => t.name === "clarifydoc_contract")?.args).toContain("path");
    expect(tools.length).toBeGreaterThan(10);
  });
});
