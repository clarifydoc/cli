import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractClasses, extractFunctions } from "../../../functions-classes/index.js";
import { extractImports } from "../../../imports-exports/index.js";
import { pythonRouteExtractor } from "../routes.js";
import { djangoUrlconfResolver, parseAction } from "./resolver.js";
import { reconcileProjectRoutes } from "../../../route-resolvers/index.js";
import { buildImportIndex, resolveImportSource } from "../../../../core/import-index.js";
import { buildClassIndex } from "../../../../core/class-index.js";
import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function analyze(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "python" as never, filePath);
    const facts: RouteFact[] = [];
    out.push({
      filePath,
      language: "python",
      projectId: "root",
      imports: extractImports(tree, src, "python" as never),
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, "python" as never),
      functions: extractFunctions(tree, src, "python" as never),
      routes: pythonRouteExtractor.extractRoutes(tree, src, filePath, facts),
      routeFacts: facts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const known = new Set(out.map((a) => a.filePath));
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(out, importIndex),
    resolveModule: (from, spec) => resolveImportSource(from, spec, known),
    fileOf: (p) => out.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(out, ctx, [djangoUrlconfResolver]);
  return out;
}

const rows = (files: FileAnalysis[]) =>
  files
    .flatMap((a) => a.routes.filter((r) => r.kind === "api").map((r) => `${r.httpMethod ?? "*"} ${r.path} ${r.handler} @${a.filePath}:${r.line}`))
    .sort();

const SHOP = {
  "config/settings.py": `ROOT_URLCONF = "config.urls"\n`,
  "config/urls.py": `
from django.urls import include, path, re_path
from rest_framework.routers import DefaultRouter
from shop.views import TagViewSet, DocumentViewSet, StatisticsView, BulkEditView

router = DefaultRouter()
router.register(r"tags", TagViewSet)
router.register(r"documents", DocumentViewSet, basename="documents")

urlpatterns = [
    re_path(
        r"^api/",
        include(
            [
                re_path("^statistics/", StatisticsView.as_view(), name="statistics"),
                re_path("^documents/", include([re_path("^bulk_edit/", BulkEditView.as_view())])),
                *router.urls,
            ]
        ),
    ),
    path("legacy/", include("legacy.urls")),
    path("admin/", admin.site.urls),
]
`,
  "shop/base.py": `
from rest_framework.viewsets import GenericViewSet
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin

class ReadViewSet(ListModelMixin, RetrieveModelMixin, GenericViewSet):
    permission_classes = [IsAuthenticated]
`,
  "shop/views.py": `
from rest_framework.viewsets import ModelViewSet
from rest_framework.views import APIView
from rest_framework.decorators import action
from shop.base import ReadViewSet

class TagViewSet(ModelViewSet):
    http_method_names = ["get", "post"]

class DocumentViewSet(ReadViewSet):
    lookup_field = "slug"

    @action(detail=True, methods=["get", "delete"], url_path=r"versions/(?P<version_id>\\d+)")
    def version(self, request, slug=None, version_id=None):
        ...

    @version.mapping.patch
    def update_version(self, request, slug=None, version_id=None):
        ...

    @action(detail=False)
    def next_asn(self, request):
        ...

class StatisticsView(APIView):
    def get(self, request):
        ...

class BulkEditView(APIView):
    def post(self, request):
        ...
`,
  "legacy/urls.py": `
from django.urls import path
from legacy import views

urlpatterns = [path("ping/", views.ping)]
`,
  "legacy/views.py": `
def ping(request):
    ...
`,
};

describe("django-urlconf", () => {
  it("composes nested re_path includes, router registrations and @actions into full paths (paperless shape)", async () => {
    const files = await analyze(SHOP);
    expect(rows(files)).toEqual([
      "* /legacy/ping/ views.ping @legacy/urls.py:5",
      "DELETE /api/documents/{slug}/versions/{version_id}/ DocumentViewSet.version @shop/views.py:14",
      "GET /api/documents/ DocumentViewSet.list @shop/views.py:10",
      "GET /api/documents/next_asn/ DocumentViewSet.next_asn @shop/views.py:22",
      "GET /api/documents/{slug}/ DocumentViewSet.retrieve @shop/views.py:10",
      "GET /api/documents/{slug}/versions/{version_id}/ DocumentViewSet.version @shop/views.py:14",
      "GET /api/statistics/ StatisticsView.get @shop/views.py:26",
      // http_method_names = ["get", "post"]: no PUT/PATCH/DELETE on tags.
      "GET /api/tags/ TagViewSet.list @shop/views.py:7",
      "GET /api/tags/{pk}/ TagViewSet.retrieve @shop/views.py:7",
      "PATCH /api/documents/{slug}/versions/{version_id}/ DocumentViewSet.update_version @shop/views.py:18",
      "POST /api/documents/bulk_edit/ BulkEditView.post @shop/views.py:30",
      "POST /api/tags/ TagViewSet.create @shop/views.py:7",
    ]);
  });

  it("carries permission_classes from the ViewSet's chain as the route's policy", async () => {
    const files = await analyze(SHOP);
    const list = files.flatMap((a) => a.routes).find((r) => r.handler === "DocumentViewSet.list")!;
    expect(list.auth).toMatchObject({ policies: ["IsAuthenticated"], anonymous: false });
  });

  it("marks a urlconf no root reaches, instead of inventing its prefix", async () => {
    const files = await analyze({
      "config/settings.py": `ROOT_URLCONF = "config.urls"\n`,
      "config/urls.py": `from django.urls import path\nurlpatterns = [path("health/", views.health)]\n`,
      "orphan/urls.py": `from django.urls import path\nurlpatterns = [path("x/", views.x)]\n`,
    });
    const orphan = files.find((a) => a.filePath === "orphan/urls.py")!;
    expect(orphan.routes[0]).toMatchObject({ path: "/x/", prefixUnresolved: "urlconf:not-included" });
  });
});

describe("parseAction", () => {
  it("reads detail, methods and url_path, with DRF's defaults", () => {
    expect(parseAction('action(detail=True, methods=["get", "post"], url_path="notes")')).toEqual({
      detail: true,
      methods: ["GET", "POST"],
      urlPath: "notes",
    });
    expect(parseAction("action(detail=False)")).toEqual({ detail: false, methods: ["GET"], urlPath: null });
    expect(parseAction("login_required")).toBeNull();
  });
});
