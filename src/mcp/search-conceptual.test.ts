import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../core/analyzer.js";
import { buildMcpServer } from "./server.js";

/**
 * A question described in words (`body: true`) that no name matches in full: the bodies and docs that
 * answer it come first, then the names sharing one of its words; and the code doing it comes before
 * the test describing it.
 */
describe("clarifydoc_search — a conceptual question", () => {
  let dir: string;
  let search: (args: Record<string, unknown>) => Promise<string>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-concept-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("package.json", '{"name":"league-api","dependencies":{"express":"4.18.0","jsonwebtoken":"9.0.0"}}');
    await file(
      "src/auth/tokens.ts",
      'import jwt from "jsonwebtoken";\nexport function issueToken(playerId: number): string {\n  return jwt.sign({ player: { id: playerId } }, process.env.SECRET ?? "dev", { expiresIn: "60d" });\n}\n',
    );
    await file("src/players/playerCard.ts", "export function playerCard(name: string) {\n  return { name };\n}\n");
    await file("src/players/routes.ts", 'import express from "express";\nconst router = express.Router();\nrouter.get("/api/v2/players/:id", (req, res) => res.json({ id: req.params.id }));\nexport default router;\n');
    await file(
      "test/tokens.test.ts",
      'import { issueToken } from "../src/auth/tokens";\nexport function signsTokenCarryingPlayerId() {\n  const token = issueToken(7);\n  // sign a token carrying the player id\n  return token.length > 0;\n}\n',
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
    const { server } = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, ".clarifydoc"), allowAnalyze: false, allowColdStart: false });
    search = async (args) => {
      const res = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_search", arguments: args } });
      return (res?.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leads with what bodies say, the code before its test, then the partial name matches", async () => {
    const text = await search({ query: "sign a token carrying the player id", body: true });
    const bullets = text.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets[0]).toMatch(/^- \[fn\] issueToken\(\) \(src\/auth\/tokens\.ts:2\)/);
    const testAt = bullets.findIndex((l) => l.includes("signsTokenCarryingPlayerId"));
    expect(testAt).toBeGreaterThan(0);
    expect(text).toMatch(/## Names matching some terms[\s\S]*\/api\/v2\/players/);
    expect(text.indexOf("## Names matching some terms")).toBeGreaterThan(text.indexOf("issueToken"));
  });

  it("keeps a test first when the question is about tests", async () => {
    const text = await search({ query: "test sign token carrying player id", body: true });
    const bullets = text.split("\n").filter((l) => l.startsWith("- [fn]"));
    expect(bullets[0]).toMatch(/signsTokenCarryingPlayerId/);
  });
});
