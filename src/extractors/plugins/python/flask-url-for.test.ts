import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Flask views named by `url_for` in Jinja templates. */
const FILES: Record<string, string> = {
  "requirements.txt": "flask\n",
  "league/clubs.py": `from flask import Blueprint, render_template
bp = Blueprint("clubs", __name__, url_prefix="/clubs")

@bp.route("/")
def index():
    return render_template("clubs/index.html")

@bp.route("/<int:club_id>/kit", methods=["POST"], endpoint="save_kit")
def update_kit(club_id):
    return ""
`,
  "league/templates/clubs/index.html": `{% extends "base.html" %}
{% block content %}
<a href="{{ url_for('clubs.index') }}">Clubs</a>
<form method="post" action="{{ url_for('clubs.save_kit', club_id=club.id) }}"><button type="submit">Save</button></form>
<img src="{{ url_for('static', filename='badge.png') }}">
{% endblock %}
`,
};

describe("Flask url_for in Jinja templates", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-flask-url-for-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names Flask routes as url_for does: blueprint.function, or the endpoint given", () => {
    expect((summary.routeMap ?? []).filter((r) => r.kind === "api").map((r) => `${r.httpMethod} ${r.path} ${r.name}`).sort())
      .toEqual(["GET /clubs/ clubs.index", "POST /clubs/<int:club_id>/kit clubs.save_kit"]);
  });

  it("links the template's link and form to the routes url_for names", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "league/templates/clubs/index.html" && l.targetSymbol.startsWith("route:"))
      .map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(links).toEqual(["clubs_index -> route:GET /clubs/", "post_clubs_save_kit -> route:POST /clubs/<int:club_id>/kit"]);
  });
});
