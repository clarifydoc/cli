import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractPythonRoutes } from "./routes.js";
import { resolveRouterMounts } from "../../shared/router-mounts.js";
import { buildImportIndex } from "../../../core/import-index.js";
import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "python" as never, "x.py");
  const routes: RouteInfo[] = [];
  extractPythonRoutes(tree.rootNode, routes);
  return routes;
}

describe("FastAPI include_router mounts", () => {
  it("emits a mount carrying the prefix and the module identifier", async () => {
    const routes = await routesOf(`
router = APIRouter()
router.include_router(authentication.router, tags=["auth"], prefix="/users")
router.include_router(tags.router, prefix="/tags")
`);
    expect(routes).toEqual([
      expect.objectContaining({ path: "/users", httpMethod: null, kind: "api", handler: "authentication", mount: true }),
      expect.objectContaining({ path: "/tags", httpMethod: null, kind: "api", handler: "tags", mount: true }),
    ]);
  });

  it("mounts at the receiving router's own prefix, with or without an include prefix (mealie)", async () => {
    const routes = await routesOf(`
router = APIRouter(prefix="/api")
router.include_router(app.router)
router.include_router(users.router, prefix="/users")
`);
    expect(routes.map((r) => [r.path, r.handler, r.mount])).toEqual([
      ["/api", "app", true],
      ["/api/users", "users", true],
    ]);
  });

  it("still emits a prefix-less mount on a prefix-less router, so mounts compose", async () => {
    const routes = await routesOf(`router.include_router(articles.router, tags=["articles"])`);
    expect(routes).toEqual([expect.objectContaining({ path: "", handler: "articles", mount: true })]);
  });

  it("resolves a module constant prefix, and marks one it cannot know", async () => {
    const routes = await routesOf(`
prefix = "/recipes"
router = APIRouter()
router.include_router(comments.router, prefix=prefix)
app.include_router(api_router, prefix=settings.api_prefix)
`);
    expect(routes[0]).toMatchObject({ path: "/recipes", handler: "comments" });
    expect(routes[1]).toMatchObject({ path: "", handler: "api_router", prefixUnresolved: "mount:settings.api_prefix" });
  });

  it("reads a project router class's prefix and puts the receiver's guards on the mount", async () => {
    const routes = await routesOf(`
router = UserAPIRouter(prefix="/recipes", route_class=MealieCrudRoute)

@router.get("/{slug}")
def get_one(slug: str): ...

admin = APIRouter(prefix="/admin", dependencies=[Depends(get_admin_user)])
admin.include_router(about.router)
`);
    expect(routes.find((r) => r.handler === "get_one")!.path).toBe("/recipes/{slug}");
    const mounted = routes.find((r) => r.mount)!;
    expect(mounted).toMatchObject({ path: "/admin", middleware: ["Depends(get_admin_user)"] });
  });

  it("reads a Flask blueprint registration as a mount", async () => {
    const routes = await routesOf(`app.register_blueprint(admin_bp, url_prefix="/admin")`);
    expect(routes).toEqual([expect.objectContaining({ path: "/admin", handler: "admin_bp", mount: true })]);
  });

  it("keeps the decorator path as written — composition is a project-level pass", async () => {
    const routes = await routesOf(`
@router.get("", response_model=ListOfArticles)
async def list_articles():
    ...
`);
    expect(routes).toEqual([
      expect.objectContaining({ path: "", httpMethod: "GET", handler: "list_articles" }),
    ]);
  });
});

/** Minimal FileAnalysis carrying only what the mount pass and import index read. */
function file(filePath: string, routes: RouteInfo[], imports: FileAnalysis["imports"] = []): FileAnalysis {
  return { filePath, routes, imports } as unknown as FileAnalysis;
}

const get = (path: string, line = 1): RouteInfo => ({
  path, httpMethod: "GET", kind: "api", handler: "h", calls: [], middleware: [], line,
});
const mount = (prefix: string, handler: string, line = 1): RouteInfo => ({
  path: prefix, httpMethod: null, kind: "api", handler, calls: [], middleware: [], line, mount: true,
});

describe("FastAPI mounts resolved across files", () => {
  it("prefixes each router's routes and drops the mounts", () => {
    // `from app.api.routes import authentication, tags` names two DIFFERENT
    // files in one statement — the import index has to resolve per specifier.
    const api = file(
      "app/api/routes/api.py",
      [mount("/users", "authentication"), mount("/tags", "tags")],
      [{ source: "app.api.routes", specifiers: ["authentication", "tags"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    );
    const auth = file("app/api/routes/authentication.py", [get("/login")]);
    const tags = file("app/api/routes/tags.py", [get("")]);

    const analyses = [api, auth, tags];
    const prefixed = resolveRouterMounts(analyses, buildImportIndex(analyses));

    expect(prefixed).toBe(2);
    expect(auth.routes.map((r) => r.path)).toEqual(["/users/login"]);
    expect(tags.routes.map((r) => r.path)).toEqual(["/tags"]);
    expect(api.routes).toEqual([]); // wiring, not endpoints
  });

  it("composes transitively through a nested router package", () => {
    // app/api/routes/articles/api.py mounts its siblings at /articles, and is
    // itself included from api.py — the FastAPI RealWorld layout.
    const inner = file(
      "app/api/routes/articles/api.py",
      [mount("/articles", "articles_resource")],
      [{ source: "app.api.routes.articles", specifiers: ["articles_resource"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    );
    const resource = file("app/api/routes/articles/articles_resource.py", [get(""), get("/{slug}")]);

    const analyses = [inner, resource];
    resolveRouterMounts(analyses, buildImportIndex(analyses));

    expect(resource.routes.map((r) => r.path)).toEqual(["/articles", "/articles/{slug}"]);
  });

  it("composes the receiving router's prefix through prefix-less includes (mealie's /api/app/about)", async () => {
    const api = file(
      "mealie/routes/__init__.py",
      [mount("/api", "app")],
      [{ source: ".", specifiers: ["app"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    );
    const appPkg = file(
      "mealie/routes/app/__init__.py",
      [mount("/app", "app_about")],
      [{ source: ".", specifiers: ["app_about"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    );
    const about = file("mealie/routes/app/app_about.py", [get("/about")]);
    const analyses = [api, appPkg, about];
    resolveRouterMounts(analyses, buildImportIndex(analyses));
    expect(about.routes.map((r) => r.path)).toEqual(["/api/app/about"]);
  });

  it("drops an empty mount that resolves to nothing", () => {
    const api = file("app/main.py", [mount("", "external_router"), get("/health")]);
    resolveRouterMounts([api], buildImportIndex([api]));
    expect(api.routes.map((r) => r.path)).toEqual(["/health"]);
  });

  it("gives colliding empty paths distinct identities, which is what dedupe needs", async () => {
    // Several routers each declare `@router.get("")`. Un-prefixed they are all
    // literally `GET ""`, and dedupeRoutes — which keys on method+path —
    // collapses five endpoints into one. This is why route-path F1 measured
    // 0.000 while declaration-site F1 was 0.848.
    const users = file("app/api/routes/users.py", [get("")]);
    const tags = file("app/api/routes/tags.py", [get("")]);
    const api = file(
      "app/api/routes/api.py",
      [mount("/user", "users"), mount("/tags", "tags")],
      [{ source: "app.api.routes", specifiers: ["users", "tags"], isDefault: false, isNamespace: false, isType: false, line: 1 }],
    );

    const analyses = [api, users, tags];
    resolveRouterMounts(analyses, buildImportIndex(analyses));

    const { dedupeRoutes } = await import("../../../core/route-linker.js");
    const all = analyses.flatMap((a) => a.routes.map((r) => ({ ...r, filePath: a.filePath })));
    expect(dedupeRoutes(all).map((r) => r.path).sort()).toEqual(["/tags", "/user"]);
  });
});

describe("FastAPI route attributes", () => {
  it("binds the handler signature: explicit markers, path tokens, scalar → query, model → body", async () => {
    const [route] = await routesOf(`
@router.post("/{user_id}")
async def create(user_id: int, body: UserCreate, q: str | None = Query(None), token: str = Header(...), current=Depends(get_current_user), page=1):
    ...
`);
    expect(route!.params).toEqual([
      { name: "user_id", type: "int", binding: "route", inferred: true },
      { name: "body", type: "UserCreate", binding: "body", inferred: true },
      { name: "q", type: "str | None", binding: "query" },
      { name: "token", type: "str", binding: "header" },
      { name: "current", type: null, binding: "services" },
      { name: "page", type: null, binding: "query", inferred: true },
    ]);
    // An auth-looking dependency is also a guard on the action.
    expect(route!.middleware).toEqual(["Depends(get_current_user)"]);
    expect(route!.auth).toEqual({ policies: ["get_current_user"], roles: [], schemes: [], anonymous: false, inherited: false });
  });

  it("reads Annotated[...] markers, injected types, UploadFile and Security scopes", async () => {
    const [route] = await routesOf(`
@app.put("/items/{item_id}")
async def put_item(item_id: int, q: Annotated[str | None, Query(max_length=50)] = None, request: Request, file: UploadFile, tasks: BackgroundTasks, db: Session = Depends(get_db), user: User = Security(get_user, scopes=["items:write"]), ids: list[int] = Query([]), payload: dict = Body(...)):
    ...
`);
    expect(route!.params).toEqual([
      { name: "item_id", type: "int", binding: "route", inferred: true },
      { name: "q", type: "str | None", binding: "query" },
      { name: "request", type: "Request", binding: "services", inferred: true },
      { name: "file", type: "UploadFile", binding: "form" },
      { name: "tasks", type: "BackgroundTasks", binding: "services", inferred: true },
      { name: "db", type: "Session", binding: "services" },
      { name: "user", type: "User", binding: "services" },
      { name: "ids", type: "list[int]", binding: "query" },
      { name: "payload", type: "dict", binding: "body" },
    ]);
    // `get_db` is not an auth check; `Security(...)` always is.
    expect(route!.auth).toEqual({ policies: ["get_user"], roles: ["items:write"], schemes: [], anonymous: false, inherited: false });
  });

  it("inherits router-level dependencies and prefix, adds route-level dependencies", async () => {
    const routes = await routesOf(`
router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(verify_token)])
public = APIRouter()

@router.get("/users", dependencies=[Depends(require_admin)])
async def list_users():
    ...

@router.get("/stats")
async def stats():
    ...

@public.get("/ping")
async def ping():
    ...
`);
    expect(routes.map((r) => r.path)).toEqual(["/admin/users", "/admin/stats", "/ping"]);
    expect(routes[0]!.middleware).toEqual(["Depends(verify_token)", "Depends(require_admin)"]);
    expect(routes[0]!.auth).toEqual({ policies: ["verify_token", "require_admin"], roles: [], schemes: [], anonymous: false, inherited: false });
    expect(routes[1]!.auth).toEqual({ policies: ["verify_token"], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(routes[2]!.auth).toBeUndefined();
    expect(routes[2]!.middleware).toEqual([]);
    expect(routes[2]!.params).toBeUndefined();
  });

  it("leaves a route without declarations untouched", async () => {
    const [route] = await routesOf(`
@app.get("/health")
def health():
    return {"ok": True}
`);
    expect(route).toEqual({ path: "/health", httpMethod: "GET", kind: "api", handler: "health", calls: [], middleware: [], line: 2 });
  });
});

describe("Flask routes", () => {
  it("expands @bp.route methods, applies url_prefix and reads guards and request access", async () => {
    const routes = await routesOf(`
bp = Blueprint("reports", __name__, url_prefix="/reports")

@bp.route("/x/<int:id>", methods=["POST", "PUT"])
@login_required
@jwt_required()
@roles_required("admin")
@permission_required("reports.edit")
def update_report(id):
    q = request.args.get("q")
    data = request.get_json()
    f = request.form["f"]
    token = request.headers.get("X-Token")
    return {}
`);
    expect(routes.map((r) => [r.httpMethod, r.path, r.handler])).toEqual([
      ["POST", "/reports/x/<int:id>", "update_report"],
      ["PUT", "/reports/x/<int:id>", "update_report"],
    ]);
    const route = routes[0]!;
    expect(route.middleware).toEqual(["login_required", "jwt_required()", 'roles_required("admin")', 'permission_required("reports.edit")']);
    expect(route.auth).toEqual({
      policies: ["login_required", "reports.edit"],
      roles: ["admin"],
      schemes: ["jwt"],
      anonymous: false,
      inherited: false,
    });
    expect(route.params).toEqual([
      { name: "id", type: "int", binding: "route", inferred: true },
      { name: "q", type: null, binding: "query", inferred: true },
      { name: "body", type: null, binding: "body", inferred: true },
      { name: "f", type: null, binding: "form", inferred: true },
      { name: "X-Token", type: null, binding: "header", inferred: true },
    ]);
  });

  it("defaults @app.route to GET and understands the verb shorthands and other guard spellings", async () => {
    const routes = await routesOf(`
@app.route("/a")
@auth.login_required
def a():
    ...

@app.post("/b")
@roles_accepted("editor", "admin")
@admin_required
def b():
    ...

@api_view(["GET"])
@permission_classes([IsAuthenticated, IsAdminUser])
@authentication_classes([TokenAuthentication])
def c(request):
    ...
`);
    // DRF's `@api_view` carries no path (that is urls.py's) — no route.
    expect(routes.map((r) => [r.httpMethod, r.path])).toEqual([["GET", "/a"], ["POST", "/b"]]);
    expect(routes[0]!.middleware).toEqual(["auth.login_required"]);
    expect(routes[0]!.auth!.policies).toEqual(["login_required"]);
    expect(routes[1]!.auth).toEqual({ policies: ["admin_required"], roles: ["editor", "admin"], schemes: [], anonymous: false, inherited: false });
  });
});
