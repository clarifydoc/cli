import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * `is_valid()` and `save()` run the serializer's own methods (real-repo FP: validators and serializers its API
 * tests post through read as untested). A `validate_<name>` runs only for a field the serializer has, with its value.
 */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\ndjangorestframework==3.15\n",
  "config/settings.py": `ROOT_URLCONF = "config.urls"\n`,
  "config/urls.py": `from django.urls import include, path
from rest_framework.routers import DefaultRouter
from league.views import ClubViewSet, PlayerView, SquadViewSet

router = DefaultRouter()
router.register(r"clubs", ClubViewSet)
router.register(r"squads", SquadViewSet)

urlpatterns = [path("api/", include(router.urls)), path("api/players/", PlayerView.as_view())]
`,
  "league/models.py": `from django.db import models


class Club(models.Model):
    name = models.CharField(max_length=100)


class Transfer(models.Model):
    fee = models.IntegerField()
`,
  "league/checks.py": `def no_reserved_name(value):
    if value == "admin":
        raise ValueError(value)
`,
  "league/serializers.py": `from rest_framework import serializers
from league.models import Club, Transfer
from league.checks import no_reserved_name


class NameCheckMixin:
    def validate_name(self, value):
        return value

    def validate_season(self, value):
        return value


class ClubSerializer(NameCheckMixin, serializers.ModelSerializer[Club]):
    nickname = serializers.CharField(validators=[no_reserved_name])

    class Meta:
        model = Club
        fields = ["name", "nickname"]

    def validate(self, attrs):
        return attrs

    def validate_unique_name(self, data, instance=None):
        return None

    def create(self, validated_data):
        return Club.objects.create(**validated_data)

    def update(self, instance, validated_data):
        Transfer.objects.create(fee=0)
        return instance


class SquadSerializer(serializers.Serializer):
    def create(self, validated_data):
        return None
`,
  "league/views.py": `from rest_framework.decorators import action
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet
from league.models import Club
from league.serializers import ClubSerializer, SquadSerializer


class ClubViewSet(ModelViewSet[Club]):
    queryset = Club.objects.all()
    serializer_class = ClubSerializer

    @action(detail=False, methods=["post"])
    def bulk(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()

    def perform_update(self, serializer):
        serializer.save()


class SquadViewSet(ModelViewSet[Club]):
    queryset = Club.objects.all()
    serializer_class = SquadSerializer

    def get_serializer_class(self):
        return ClubSerializer


class PlayerView(APIView):
    def post(self, request):
        s = ClubSerializer(data=request.data)
        s.is_valid()
        s.save()

    def put(self, request):
        s = ClubSerializer(self.club, data=request.data)
        s.save()

    def patch(self, request, *args):
        s = ClubSerializer(*args)
        s.save()
`,
};

describe("a DRF serializer's is_valid() and save() run its project methods", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-drf-serializers-"));
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

  const linked = (source: string, strategy: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === source && l.strategy === strategy)
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();
  const VALIDATION = [
    "league/checks.py::no_reserved_name",
    "league/serializers.py::ClubSerializer.validate",
    "league/serializers.py::NameCheckMixin.validate_name",
  ];

  it("a typed local: is_valid() runs the field checks, save() create() — or update() when built with an instance", () => {
    expect(linked("PlayerView.post", "dispatch:drf-serializer")).toEqual([
      ...VALIDATION.map((t) => `s.is_valid -> ${t}`),
      "s.save -> league/serializers.py::ClubSerializer.create",
    ].sort());
    expect(linked("PlayerView.put", "dispatch:drf-serializer")).toEqual(["s.save -> league/serializers.py::ClubSerializer.update"]);
    // Arguments spread from a tuple: whether it has an instance is unknown.
    expect(linked("PlayerView.patch", "dispatch:drf-serializer")).toEqual([]);
  });

  it("self.get_serializer(…) and perform_update's serializer are the view's serializer_class", () => {
    expect(linked("ClubViewSet.bulk", "dispatch:drf-serializer")).toEqual([
      ...VALIDATION.map((t) => `serializer.is_valid -> ${t}`),
      "serializer.save -> league/serializers.py::ClubSerializer.create",
    ].sort());
    expect(linked("ClubViewSet.perform_update", "dispatch:drf-serializer")).toEqual(["serializer.save -> league/serializers.py::ClubSerializer.update"]);
  });

  it("a library action hands the request to the view's serializer", () => {
    expect(linked("route:POST /api/clubs/", "dispatch:drf-action")).toEqual([
      ...VALIDATION.map((t) => `serializer.is_valid -> ${t}`),
      "serializer.save -> league/serializers.py::ClubSerializer.create",
    ].sort());
    expect(linked("route:PUT /api/clubs/{pk}/", "dispatch:drf-action")).toEqual([
      ...VALIDATION.map((t) => `serializer.is_valid -> ${t}`),
      "self.perform_update -> league/views.py::ClubViewSet.perform_update",
    ].sort());
  });

  it("a view picking its serializer at run time joins none", () => {
    expect(linked("route:POST /api/squads/", "dispatch:drf-action")).toEqual(["self.get_serializer_class -> league/views.py::SquadViewSet.get_serializer_class"]);
  });
});
