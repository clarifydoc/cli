import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * CommonJS controllers whose handlers are assigned to `exports` members
 * (`exports.listClubs = async (req, res) => …`), required by an Express router
 * and by another module, beside namesakes that uniqueness alone would pick.
 */
describe("CommonJS member-assigned functions, end to end", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-cjs-"));
    const root = join(dir, "league");
    await mkdir(join(root, "controllers"), { recursive: true });
    await mkdir(join(root, "models"), { recursive: true });
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "league", dependencies: { express: "4.18.0", mongoose: "7.0.0" } }));
    await writeFile(join(root, "models", "club.js"), [
      "const mongoose = require('mongoose');",
      "const clubSchema = new mongoose.Schema({ name: String });",
      "module.exports = mongoose.model('Club', clubSchema);",
    ].join("\n"));
    await writeFile(join(root, "controllers", "clubController.js"), [
      "const Club = require('../models/club');",
      "exports.listClubs = async (req, res) => {",
      "  const clubs = await Club.find();",
      "  res.json(clubs);",
      "};",
      "module.exports.createClub = function (req, res) {",
      "  return Club.create(req.body);",
      "};",
    ].join("\n"));
    await writeFile(join(root, "kickoff.js"), "module.exports = function kickoff(team) {\n  return team;\n};\n");
    await writeFile(join(root, "legacy", "namesakes.js"), [
      "function listClubs() { return []; }",
      "function kickoff() { return 0; }",
      "module.exports = { listClubs, kickoff };",
    ].join("\n"));
    await writeFile(join(root, "routes.js"), [
      "const express = require('express');",
      "const clubController = require('./controllers/clubController');",
      "const router = express.Router();",
      "router.get('/clubs', clubController.listClubs);",
      "router.post('/clubs', clubController.createClub);",
      "module.exports = router;",
    ].join("\n"));
    await writeFile(join(root, "season.js"), [
      "const clubs = require('./controllers/clubController');",
      "const kickoff = require('./kickoff');",
      "function openSeason(req, res) {",
      "  clubs.listClubs(req, res);",
      "  return kickoff('home');",
      "}",
      "module.exports = { openSeason };",
    ].join("\n"));
    // A project module named like a Node built-in, and a file importing the built-in.
    await writeFile(join(root, "legacy", "assert.js"), "exports.assert = (ok, message) => {\n  if (!ok) throw new Error(message);\n};\n");
    await writeFile(join(root, "referee.js"), "const assert = require('assert');\nfunction check(card) {\n  assert(card);\n}\nmodule.exports = { check };\n");
    await mkdir(join(root, "lambda"), { recursive: true });
    await writeFile(join(root, "lambda", "fixtures.js"), [
      "const Club = require('../models/club');",
      "exports.handler = async (event) => {",
      "  const clubs = await Club.find();",
      "  return { statusCode: 200, body: JSON.stringify(clubs) };",
      "};",
    ].join("\n"));
    await writeFile(join(root, "serverless.yml"), [
      "service: league",
      "provider:",
      "  name: aws",
      "  runtime: nodejs18.x",
      "functions:",
      "  listFixtures:",
      "    handler: lambda/fixtures.handler",
      "    events:",
      "      - http:",
      "          path: fixtures",
      "          method: get",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const target = async (sourceSymbol: string, callName: string) => {
    const summary = await loadReportSummary(join(dir, "out"));
    const link = summary.symbolLinks?.find((l) => l.sourceSymbol === sourceSymbol && l.callName === callName);
    return link && `${link.targetFile}::${link.targetSymbol}`;
  };

  it("links a requirer's member call and a `module.exports = function` default to their definitions", async () => {
    expect(await target("openSeason", "clubs.listClubs")).toBe("controllers/clubController.js::listClubs");
    expect(await target("openSeason", "kickoff")).toBe("kickoff.js::kickoff");
  });

  it("gives the Express routes their handlers, and the routes reach the model", async () => {
    expect(await target("route:GET /clubs", "clubController.listClubs")).toBe("controllers/clubController.js::listClubs");
    expect(await target("route:POST /clubs", "clubController.createClub")).toBe("controllers/clubController.js::createClub");
    const summary = await loadReportSummary(join(dir, "out"));
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`);
    expect(flows).toEqual(expect.arrayContaining(["GET /clubs db Club", "POST /clubs db-write Club"]));
  });

  it("anchors a serverless route on the Lambda's `exports.handler`", async () => {
    expect(await target("route:GET /fixtures", "handler")).toBe("lambda/fixtures.js::handler");
  });

  it("never takes a Node built-in for a project module of the same name", async () => {
    expect(await target("check", "assert")).toBeUndefined();
  });
});
