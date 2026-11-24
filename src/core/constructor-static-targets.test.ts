import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A URL that reads a static through the instance's class (`this.constructor.BASE`) once stopped the
 * whole analysis: the class's field-value map was looked up by the key `constructor` and answered
 * with `Object`'s own function. The static is the class's own, a subclass's when it states one;
 * an instance field of that name is no static, and `this.toString()` is no field.
 */
const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.2.0" } }),
  "web/src/club-api.ts": `export class ClubApi {
  static BASE = "/api";
  list() { return fetch((this.constructor as any).BASE + "/clubs"); }
  one(id: string) { return fetch(\`\${(this.constructor as typeof ClubApi).BASE}/clubs/\${id}\`); }
  plain() { return fetch(\`\${this.constructor.BASE}/clubs/plain\`); }
  named() { return fetch(this.toString() + "/clubs/named"); }
}

export class LeagueApi extends ClubApi {
  static BASE = "/league";
}

export class Car {
  BASE = "/garage";
  drive() { return fetch(\`\${this.constructor.BASE}/drive\`); }
}
`,
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0" } }),
  "api/server.js": `const express = require("express");
const app = express();
app.get("/api/clubs", (req, res) => res.json([]));
app.get("/api/clubs/:id", (req, res) => res.json({}));
app.get("/api/clubs/plain", (req, res) => res.json([]));
app.get("/league/clubs", (req, res) => res.json([]));
app.get("/garage/drive", (req, res) => res.json([]));
`,
};

describe("a URL reading a static through this.constructor", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ctor-static-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the class's own static, and each subclass's", () => {
    const calls = summary.apiCalls.filter((c) => c.filePath === "web/src/club-api.ts" && c.line <= 6).map((c) => `${c.line} ${c.target} ${c.viaSubclass ?? "-"}`).sort();
    expect(calls).toEqual([
      "3 /api/clubs -",
      "3 /league/clubs LeagueApi",
      "4 /api/clubs/${id} -",
      "4 /league/clubs/${id} LeagueApi",
      "5 /api/clubs/plain -",
      "5 /league/clubs/plain LeagueApi",
      // A method's result is no field: `this.toString()` reads nothing.
      "6 /clubs/named -",
    ]);
  });

  it("links the class's requests to the routes they reach", () => {
    const links = (summary.apiRouteLinks ?? []).filter((l) => l.sourceLine <= 6).map((l) => `${l.sourceLine} ${l.routePath} ${l.confidence}`).sort();
    expect(links).toEqual(expect.arrayContaining(["3 /api/clubs EXTRACTED", "3 /league/clubs EXTRACTED", "4 /api/clubs/:id EXTRACTED", "5 /api/clubs/plain EXTRACTED"]));
  });

  it("never reads an instance field as the static", () => {
    const drive = summary.apiCalls.filter((c) => c.filePath === "web/src/club-api.ts" && c.line === 15);
    expect(drive.map((c) => c.target)).not.toContain("/garage/drive");
  });
});
