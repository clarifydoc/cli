import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/** An Express app rendering EJS views: the route that renders a view serves its screen, whose form and links reach routes. */
describe("EJS views", () => {
  let summary: ProjectAnalysis;
  let root: string;
  let out: string;
  const files: Record<string, string> = {
    "package.json": `{"name":"club-app","dependencies":{"express":"4","ejs":"3"}}`,
    "server.js": `const express = require('express');
const app = express();
app.set('view engine', 'ejs');
function listClubs(req, res) { res.render('clubs/list', { clubs: [] }); }
function addClub(req, res) { res.redirect('/clubs'); }
function showClub(req, res) { res.render('clubs/detail', { id: req.params.id }); }
app.get('/clubs', listClubs);
app.post('/clubs', addClub);
app.get('/clubs/:id', showClub);
app.listen(3000);
`,
    "views/clubs/list.ejs": `<%- include('../partials/header') %>
<h1>Clubs</h1>
<% clubs.forEach(function (club) { %>
  <a href="/clubs/<%= club.id %>"><%= club.name %></a>
<% }) %>
<form method="post" action="/clubs"><input name="name"><button type="submit">Add</button></form>
`,
    "views/clubs/detail.ejs": `<h1>Club</h1><a href="/clubs">Back</a>\n`,
    "views/partials/header.ejs": `<nav><a href="/clubs">Clubs</a></nav>\n`,
    // a namesake view of another folder: only the folder the route names is its page
    "views/cars/list.ejs": `<h1>Cars</h1><a href="/cars">Cars</a>\n`,
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-ejs-src-"));
    out = mkdtempSync(join(tmpdir(), "clarifydoc-ejs-out-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    summary = await loadReportSummary(out);
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("discovers the views as screens served at the route that renders them", () => {
    const pages = Object.fromEntries((summary.screens ?? []).filter((s) => s.filePath.endsWith(".ejs") && s.routePath).map((s) => [s.filePath, s.routePath]));
    expect(pages).toEqual({ "views/clubs/list.ejs": "/clubs", "views/clubs/detail.ejs": "/clubs/:id" });
  });

  it("joins the view's form and link calls to their routes", () => {
    const rows = (summary.apiRouteLinks ?? []).filter((l) => l.source === "views/clubs/list.ejs").map((l) => `${l.method} ${l.url} -> ${l.routePath}`).sort();
    expect(rows).toEqual(["GET /clubs/:param -> /clubs/:id", "POST /clubs -> /clubs"]);
  });
});
