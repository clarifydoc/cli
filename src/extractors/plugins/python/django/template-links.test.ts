import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * Django templates that reach their views by route name (real-repo FP: 406
 * templates were page routes at their file paths, and none of 469
 * `{% url %}` references reached a view).
 */
const FILES: Record<string, string> = {
  "manage.py": "import django\n",
  "league/settings.py": `ROOT_URLCONF = "league.urls"\n`,
  "league/urls.py": `from django.urls import include, path
urlpatterns = [
    path("clubs/", include("clubs.urls")),
]
`,
  "clubs/urls.py": `from django.urls import path
from . import views
app_name = "clubs"
urlpatterns = [
    path("", views.club_list, name="list"),
    path("add/", views.ClubCreateView.as_view(), name="add"),
    path("<int:pk>/badge/", views.club_badge, name="badge"),
]
`,
  "clubs/views.py": `from django.views.generic import CreateView
from django.shortcuts import render
from .models import Club

def club_list(request):
    return render(request, "clubs/list.html", {"clubs": Club.objects.all()})

def club_badge(request, pk):
    return render(request, "clubs/badge.html", {"club": Club.objects.get(pk=pk)})

class ClubCreateView(CreateView):
    model = Club
    fields = ["name"]
    template_name = "clubs/form.html"
`,
  "clubs/models.py": `from django.db import models
class Club(models.Model):
    name = models.CharField(max_length=80)
`,
  "clubs/templates/clubs/list.html": `{% extends "base.html" %}
{% block content %}
<a href="{% url 'clubs:add' %}">New club</a>
<form method="post" action="{% url 'clubs:add' %}">{% csrf_token %}<button type="submit">Save</button></form>
<div hx-get="{% url 'clubs:badge' club.pk %}">badge</div>
{% include "clubs/_row.html" %}
{% endblock %}
`,
  "clubs/templates/clubs/form.html": `{% extends "base.html" %}
{% block content %}<form method="post">{% csrf_token %}{{ form }}<button type="submit">Save</button></form>{% endblock %}
`,
  "templates/static-page.html": `<html><body><a href="/about">About</a></body></html>\n`,
};

describe("Django templates and route names", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-django-templates-"));
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

  it("names urlconf routes under their app's namespace", () => {
    const named = (summary.routeMap ?? []).filter((r) => r.name).map((r) => `${r.httpMethod ?? "*"} ${r.path} ${r.name}`).sort();
    expect(named).toEqual(expect.arrayContaining(["* /clubs/ clubs:list", "* /clubs/{pk}/badge/ clubs:badge"]));
    expect(named.some((n) => n.endsWith(" clubs:add"))).toBe(true);
  });

  it("reads a Django template as a server template, not a page served at its path", () => {
    const frontend = (summary.routeMap ?? []).filter((r) => r.kind === "frontend").map((r) => r.path);
    expect(frontend).not.toContain("/clubs/templates/clubs/list.html");
    expect(frontend).toContain("/templates/static-page.html");
  });

  it("links the template's link, form and htmx request to the routes they name", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "clubs/templates/clubs/list.html" && l.targetSymbol.startsWith("route:"))
      .map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`).sort();
    expect(links).toEqual(["clubs_add -> route:GET /clubs/add/", "clubs_badge -> route:USE /clubs/{pk}/badge/", "post_clubs_add -> route:POST /clubs/add/"]);
  });

  it("gives a template the route whose view renders it, a class-based view by its template_name", () => {
    const at = (file: string) => (summary.screens ?? []).find((sc) => sc.filePath === file)?.routePath;
    expect(at("clubs/templates/clubs/list.html")).toBe("/clubs/");
    expect(at("clubs/templates/clubs/form.html")).toBe("/clubs/add/");
  });
});
