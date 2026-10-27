import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** "Which agent tool writes this table": an MCP tool's handler followed to the database. */
describe("entry points, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-entry-"));
    const root = join(dir, "srv");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "srv", dependencies: { "@modelcontextprotocol/sdk": "1.0.0", pg: "8.11.0" } }));
    await writeFile(join(root, "src", "cars.ts"), [
      'import { Pool } from "pg";',
      "const pool = new Pool();",
      "export async function saveCar(args: { id: string }) {",
      '  await pool.query("INSERT INTO cars (id) VALUES ($1)", [args.id]);',
      "}",
    ].join("\n"));
    await writeFile(join(root, "src", "server.ts"), [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { saveCar } from "./cars";',
      'const server = new McpServer({ name: "shop", version: "1" });',
      'server.tool("save_car", { id: "string" }, saveCar);',
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the tool and follows its handler to the table it writes", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    expect(s.entryPoints?.map((e) => `${e.kind} ${e.name} → ${e.handler} @ ${e.filePath}:${e.line}`)).toEqual(["mcp-tool save_car → saveCar @ src/server.ts:4"]);
    const flows = (s.dataFlows ?? []).filter((f) => f.entryKind === "command");
    expect(flows.map((f) => `${f.entryLabel} → ${f.effect} ${f.resource}`)).toContain("MCP tool save_car → db-write cars");
  });
});
