import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * A router-registered ViewSet's action runs DRF's own code, which calls the hooks the
 * project overrides (real-repo FP: routes whose `partial_update` only adds a check before
 * `super().partial_update(…)`, and whose `perform_update` writes the data, reached nothing).
 */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\ndjangorestframework==3.15\n",
  "config/settings.py": `ROOT_URLCONF = "config.urls"\n`,
  "config/urls.py": `from django.urls import include, path
from rest_framework.routers import DefaultRouter
from league.views import ClubViewSet, PlayerViewSet, TransferViewSet

router = DefaultRouter()
router.register(r"clubs", ClubViewSet)
router.register(r"players", PlayerViewSet)
router.register(r"transfers", TransferViewSet)

urlpatterns = [path("api/", include(router.urls))]
`,
  "league/models.py": `from django.db import models


class Club(models.Model):
    name = models.CharField(max_length=100)


class Player(models.Model):
    name = models.CharField(max_length=100)


class Transfer(models.Model):
    fee = models.IntegerField()


class Injury(models.Model):
    days = models.IntegerField()
`,
  "league/base.py": `from rest_framework.viewsets import ModelViewSet


class LeagueViewSet(ModelViewSet):
    def perform_destroy(self, instance):
        instance.delete()
`,
  "league/views.py": `from rest_framework.viewsets import ModelViewSet
from league.base import LeagueViewSet
from league.models import Club, Player, Transfer, Injury


class SquadMixin:
    pass


class SquadView(SquadMixin):
    pass


class ClubViewSet(ModelViewSet[Club]):
    queryset = Club.objects.all()

    def partial_update(self, request, *args, **kwargs):
        if "id" in request.data:
            return None
        return super().partial_update(request, *args, **kwargs)

    def perform_destroy(self, instance):
        Transfer.objects.filter(club=instance).delete()


class PlayerViewSet(LeagueViewSet):
    def get_queryset(self):
        return Player.objects.filter(active=True)

    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

    def perform_update(self, serializer):
        Injury.objects.create(days=1)


class TransferViewSet(ModelViewSet[Transfer]):
    queryset = Transfer.objects.all()

    def update(self, request, *args, **kwargs):
        return None

    def perform_update(self, serializer):
        Injury.objects.create(days=2)
`,
};

describe("a DRF ViewSet's routes run its action and the hooks DRF calls", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-drf-actions-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const dispatched = (route: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === `route:${route}` && l.strategy === "dispatch:drf-action")
      .map((l) => `${l.targetFile}::${l.targetSymbol}`)
      .sort();
  const reachesData = (route: string) =>
    (summary.dataFlows ?? []).some((f) => f.entryKind === "route" && f.entryLabel === route && f.effect !== "api-call");

  it("a project action handing on to super() runs the library action on the viewset: its queryset", () => {
    expect(dispatched("PATCH /api/clubs/{pk}/")).toEqual(["league/views.py::ClubViewSet"]);
    expect(reachesData("PATCH /api/clubs/{pk}/")).toBe(true);
  });

  it("the library action calls the hooks the viewset or its project base overrides", () => {
    // (The route already reaches the viewset's own body, its queryset, as a framework-supplied action.)
    expect(dispatched("DELETE /api/clubs/{pk}/")).toEqual(["league/views.py::ClubViewSet.perform_destroy"]);
    // An overridden get_queryset replaces the class-level queryset; a base's perform_destroy is the one that runs.
    expect(dispatched("DELETE /api/players/{pk}/")).toEqual(["league/base.py::LeagueViewSet.perform_destroy", "league/views.py::PlayerViewSet.get_queryset"]);
    expect(dispatched("PATCH /api/players/{pk}/")).toEqual(["league/views.py::PlayerViewSet.get_queryset", "league/views.py::PlayerViewSet.perform_update"]);
    expect(dispatched("PUT /api/players/{pk}/")).toEqual(["league/views.py::PlayerViewSet.get_queryset", "league/views.py::PlayerViewSet.perform_update"]);
    expect(reachesData("PUT /api/players/{pk}/")).toBe(true);
  });

  it("an action the project writes without super() runs no library hook", () => {
    expect(dispatched("PUT /api/transfers/{pk}/")).toEqual([]);
    // partial_update is the library's, which calls the project's update.
    expect(dispatched("PATCH /api/transfers/{pk}/")).toEqual(["league/views.py::TransferViewSet.update"]);
  });

  it("super() in a method resolves on its own class's bases, never another class of the file", () => {
    const bad = (summary.symbolLinks ?? []).filter((l) => l.sourceSymbol === "PlayerViewSet.partial_update" && l.targetSymbol.endsWith(".partial_update"));
    expect(bad).toEqual([]);
  });
});
