import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * What DRF's library code does that no project line says (real-repo FP: a ModelViewSet's POST / PUT / DELETE routes
 * reached no table they write, a `serializer.data` ran no `get_<field>` method, a `serializer.save()` wrote nothing).
 */
const FILES: Record<string, string> = {
  "requirements.txt": "django==5.0\ndjangorestframework==3.15\n",
  "config/settings.py": `ROOT_URLCONF = "config.urls"\nINSTALLED_APPS = ["league"]\n`,
  "config/urls.py": `from django.urls import include, path
from rest_framework.routers import DefaultRouter
from league.views import CarViewSet, ClubViewSet, GarageViewSet, NewPlayerView, SquadView, SignupView, BadgeView, TableView

router = DefaultRouter()
router.register(r"cars", CarViewSet)
router.register(r"clubs", ClubViewSet)
router.register(r"garages", GarageViewSet)

urlpatterns = [
    path("api/", include(router.urls)),
    path("players/", NewPlayerView.as_view()),
    path("squad/", SquadView.as_view()),
    path("signup/", SignupView.as_view()),
    path("badges/", BadgeView.as_view()),
    path("table/", TableView.as_view()),
]
`,
  "league/models.py": `from django.db import models


class Club(models.Model):
    name = models.CharField(max_length=100)


class Player(models.Model):
    club = models.ForeignKey(Club, related_name="players", on_delete=models.CASCADE)


class Car(models.Model):
    name = models.CharField(max_length=100)


class Garage(models.Model):
    name = models.CharField(max_length=100)


class Badge(models.Model):
    label = models.CharField(max_length=100)


class Standing(models.Model):
    points = models.IntegerField()
`,
  "league/serializers.py": `from rest_framework import serializers
from league.models import Badge, Car, Club, Garage, Player, Standing


class ClubSerializer(serializers.ModelSerializer):
    size = serializers.SerializerMethodField()
    rank = serializers.SerializerMethodField(method_name="current_rank")

    class Meta:
        model = Club
        fields = "__all__"

    def get_size(self, obj):
        return Player.objects.filter(club=obj).count()

    def current_rank(self, obj):
        return Standing.objects.filter(points__gt=0).count()

    def get_unused(self, obj):
        return Garage.objects.count()


class CarSerializer(serializers.ModelSerializer):
    class Meta:
        model = Car
        fields = "__all__"


class PlayerSerializer(serializers.ModelSerializer):
    class Meta:
        model = Player
        fields = "__all__"


class BadgeSerializer(serializers.ModelSerializer):
    class Meta:
        model = Badge
        fields = "__all__"

    def create(self, validated_data):
        return validated_data


class PlainSerializer(serializers.Serializer):
    label = serializers.CharField()

    class Meta:
        model = Garage
`,
  "league/views.py": `from rest_framework import generics, viewsets
from rest_framework.response import Response
from rest_framework.views import APIView
from league.models import Car, Club, Garage, Player
from league.serializers import BadgeSerializer, CarSerializer, ClubSerializer, PlainSerializer, PlayerSerializer


class CarViewSet(viewsets.ModelViewSet):
    queryset = Car.objects.all()
    serializer_class = CarSerializer


class ClubViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Club.objects.all()
    serializer_class = ClubSerializer


class GarageViewSet(viewsets.ModelViewSet):
    queryset = Garage.objects.all()

    def create(self, request):
        return Response({"made": True})


class NewPlayerView(generics.CreateAPIView):
    queryset = Player.objects.all()
    serializer_class = PlayerSerializer


class SquadView(APIView):
    def get(self, request):
        club = Club.objects.first()
        return Response(ClubSerializer(club).data)


class SignupView(APIView):
    def post(self, request):
        serializer = ClubSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response({"ok": True})


class BadgeView(APIView):
    def post(self, request):
        serializer = BadgeSerializer(data=request.data)
        serializer.is_valid()
        serializer.save()
        plain = PlainSerializer(data=request.data)
        plain.save()
        return Response(plain.data)


class TableView(APIView):
    def get(self, request):
        result = Response({"a": 1})
        return Response(result.data)
`,
};

describe("DRF library effects", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-drf-library-"));
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

  const flows = (effect: string) =>
    (summary.dataFlows ?? []).filter((f) => f.entryKind === "route" && f.effect === effect).map((f) => `${f.entryLabel} ${f.resource}`).sort();

  it("a viewset action the project does not write saves into its queryset's model", () => {
    const writes = flows("db-write");
    expect(writes).toContain("POST /api/cars/ Car");
    expect(writes).toContain("PUT /api/cars/{pk}/ Car");
    expect(writes).toContain("PATCH /api/cars/{pk}/ Car");
    expect(writes).toContain("DELETE /api/cars/{pk}/ Car");
    // A read-only viewset, a list and a create the project replaced write nothing.
    expect(writes.filter((w) => w.includes("/api/clubs/"))).toEqual([]);
    expect(writes).not.toContain("GET /api/cars/ Car");
    expect(writes).not.toContain("POST /api/garages/ Garage");
    expect(writes).toContain("DELETE /api/garages/{pk}/ Garage");
  });

  it("a generic view's verb writes its queryset's model", () => {
    expect(flows("db-write")).toContain("POST /players/ Player");
  });

  it("serializer.save() writes Meta.model unless the project's create runs instead", () => {
    const writes = flows("db-write");
    expect(writes).toContain("POST /signup/ Club");
    // BadgeSerializer's own `create` runs; a plain Serializer has no Meta.model table.
    expect(writes).not.toContain("POST /badges/ Badge");
    expect(writes).not.toContain("POST /badges/ Garage");
  });

  it("serializer.data runs the method fields' methods", () => {
    const reads = flows("db-read");
    // `size` → get_size, `rank` → current_rank (method_name=); `get_unused` names no field.
    expect(reads).toContain("GET /squad/ Player");
    expect(reads).toContain("GET /squad/ Standing");
    expect(reads.filter((r) => r.endsWith(" Garage") && r.includes("/squad/"))).toEqual([]);
    // A read-only viewset's list serializes through its serializer_class.
    expect(reads).toContain("GET /api/clubs/ Player");
    // `.data` of a response is no serializer's.
    expect(reads.filter((r) => r.startsWith("GET /table/"))).toEqual([]);
  });
});
