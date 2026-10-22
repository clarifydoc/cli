import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: 948 DRF routes; none reached the model its viewset's `queryset` names. */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\ndjangorestframework==3.15\n",
  "config/settings.py": `ROOT_URLCONF = "config.urls"\n`,
  "config/urls.py": `from django.urls import include, path
from rest_framework.routers import DefaultRouter
from league.api.views import ClubViewSet

router = DefaultRouter()
router.register(r"clubs", ClubViewSet)

urlpatterns = [path("api/", include(router.urls))]
`,
  "league/models.py": `from django.db import models


class Club(models.Model):
    name = models.CharField(max_length=100)
`,
  "league/api/viewsets.py": `from rest_framework import viewsets


class LeagueModelViewSet(viewsets.ModelViewSet):
    def list(self, request):
        return self.paginate(self.get_queryset())

    def retrieve(self, request, pk=None):
        return self.get_object()
`,
  "league/api/views.py": `from league.models import Club
from league.api.viewsets import LeagueModelViewSet


class ClubViewSet(LeagueModelViewSet):
    queryset = Club.objects.all()
`,
};

describe("a DRF viewset's queryset", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-viewset-queryset-"));
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

  it("is what the routes it inherits its handlers for read", () => {
    const routes = summary.routeMap.filter((r) => r.owner === "ClubViewSet").map((r) => `${r.httpMethod} ${r.path}`).sort();
    expect(routes.length).toBeGreaterThan(0);
    const reads = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route" && f.resource === "Club").map((f) => f.entryLabel).sort();
    expect(reads).toEqual(routes);
  });
});
