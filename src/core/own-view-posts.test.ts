import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A server-rendered `<form method="post">` with no action posts to the page's own URL: the route that
 * renders the template (Flask `render_template`, here). Form-first shapes only; decoys stay unlinked.
 */
const page = (body: string): string => `{% extends "base.html" %}\n{% block content %}\n${body}\n{% endblock %}\n`;
const files: Record<string, string> = {
  "app.py": `import sqlite3
from flask import Flask, render_template, request

app = Flask(__name__)


def db():
    return sqlite3.connect("league.db")


@app.route("/clubs/new", methods=["GET", "POST"])
def new_club():
    if request.method == "POST":
        db().execute("INSERT INTO clubs (name) VALUES (?)", (request.form["name"],))
    return render_template("club_form.html")


@app.route("/players/new", methods=["GET", "POST"])
def new_player():
    if request.method == "POST":
        db().execute("INSERT INTO players (name) VALUES (?)", (request.form["name"],))
    return render_template("player_form.html")


@app.route("/search")
def search():
    return render_template("search.html")


@app.route("/first")
def first():
    return render_template("shared_form.html")


@app.route("/second")
def second():
    return render_template("shared_form.html")
`,
  "templates/base.html": `<!doctype html>\n<html><body>\n  <nav><a href="/search">Search</a></nav>\n  {% block content %}{% endblock %}\n</body></html>\n`,
  "templates/club_form.html": page(`<form method="post">\n  <input name="name">\n  <button type="submit">Save</button>\n</form>`),
  "templates/player_form.html": page(`<form action="" method="POST">\n  <input name="name">\n  <button type="submit">Save</button>\n</form>`),
  // Decoys: a GET form without an action reads its own page; an explicit action goes where it says.
  "templates/search.html": page(`<form method="get">\n  <input name="q">\n  <button type="submit">Find</button>\n</form>\n<form method="post" action="/clubs/new">\n  <input name="name">\n  <button type="submit">Add club</button>\n</form>`),
  // Decoy: one template served at two URLs posts to whichever the browser opened.
  "templates/shared_form.html": page(`<form method="post">\n  <input name="name">\n  <button type="submit">Save</button>\n</form>`),
};

describe("a POST form with no action", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ownview-"));
    const root = join(dir, "app");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const s = await loadReportSummary(out);
    links = (s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method ?? ""} ${(s.routeMap ?? []).find((r) => r.filePath === l.target)?.path ?? ""}`).sort();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("posts to the route that renders its page, with or without an empty action", () => {
    expect(links.filter((l) => l.startsWith("templates/club_form.html"))).toHaveLength(1);
    expect(links.filter((l) => l.startsWith("templates/player_form.html"))).toHaveLength(1);
  });

  it("leaves a GET form, an explicit action's form and a template served at two URLs alone", () => {
    expect(links.filter((l) => l.startsWith("templates/search.html"))).toHaveLength(1); // only the explicit action
    expect(links.some((l) => l.startsWith("templates/shared_form.html"))).toBe(false);
  });
});
