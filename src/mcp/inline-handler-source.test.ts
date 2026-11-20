/** `clarifydoc_extract` and `clarifydoc_explain` on a route whose handler is written inline: its body is the source. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { buildMcpServer } from "./server.js";

let root = "";
let server: ReturnType<typeof buildMcpServer>["server"];

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return r.result.content[0]!.text;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "clarifydoc-inline-handler-"));
  await writeFile(join(root, "package.json"), '{"name":"league","dependencies":{"express":"4"}}', "utf-8");
  await writeFile(join(root, "db.js"), "exports.query = (q) => q;\n", "utf-8");
  await writeFile(
    join(root, "clubs.js"),
    [
      "const express = require('express');",
      "const router = express.Router();",
      "const db = require('./db');",
      "async function listClubs(req, res) {",
      "  res.json(await db.query('SELECT * FROM clubs'));",
      "}",
      "router.get('/clubs', listClubs);",
      "router.post('/clubs', async (req, res) => {",
      "  const club = await db.query('INSERT INTO clubs (name) VALUES ($1)', [req.body.name]);",
      "  res.status(201).json(club);",
      "});",
      "module.exports = router;",
      "",
    ].join("\n"),
    "utf-8",
  );
  ({ server } = buildMcpServer({ projectRoot: root, analysisDir: join(root, ".clarifydoc", basename(root)), allowAnalyze: true, allowColdStart: true }));
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a route with an inline handler", () => {
  it("clarifydoc_extract returns the inline body", async () => {
    const text = await call("clarifydoc_extract", { symbol: "route:POST /clubs", depth: 0 });
    expect(text).toContain("INSERT INTO clubs");
    expect(text).toContain("res.status(201).json(club)");
    expect(text).not.toContain("SELECT * FROM clubs");
  });

  it("clarifydoc_explain has a Handler source section with the inline body", async () => {
    const text = await call("clarifydoc_explain", { subject: "POST /clubs" });
    expect(text).toContain("Handler source");
    expect(text).toContain("INSERT INTO clubs");
  });

  it("the named-handler decoy keeps its section", async () => {
    const text = await call("clarifydoc_explain", { subject: "GET /clubs" });
    expect(text).toContain("Handler source");
    expect(text).toContain("SELECT * FROM clubs");
    expect(text).not.toContain("INSERT INTO clubs");
  });
});
