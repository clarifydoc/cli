import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A contract row a code route already serves is not joined to a function that only shares the name its path spells. */
const FILES: Record<string, string> = {
  "docs/openapi.yaml": `openapi: 3.0.0
info: {title: League, version: "1.0"}
paths:
  /api/v1/clubs/{id}:
    delete:
      operationId: clubDelete
      responses: {"200": {description: ok}}
  /api/v1/players:
    get:
      operationId: playerList
      responses: {"200": {description: ok}}
`,
  "server/app.js": `const express = require("express");
const app = express();
function destroyClub(req, res) { res.send("ok"); }
app.delete("/api/v1/clubs/:id", destroyClub);
module.exports = app;
`,
  "web/clubs.js": `export function deleteClubs(ids) { return ids.length; }
export function getPlayers() { return []; }
`,
};

describe("spec join beside a code route of the same method and path", () => {
  let dir: string;
  let links: Array<{ sourceSymbol: string; targetSymbol: string; strategy?: string }>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-spec-twin-"));
    for (const [p, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "src", p)), { recursive: true });
      await writeFile(join(dir, "src", p), text);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    links = (await loadReportSummary(join(dir, "out"))).symbolLinks ?? [];
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("does not join the served contract row to a namesake client function", () => {
    expect(links.filter((l) => l.strategy === "spec-join" && l.sourceSymbol.startsWith("route:DELETE"))).toEqual([]);
  });

  it("still joins a contract row no code serves", () => {
    expect(links.some((l) => l.strategy === "spec-join" && l.sourceSymbol === "route:GET /api/v1/players" && l.targetSymbol === "getPlayers")).toBe(true);
  });
});
