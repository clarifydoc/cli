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
      expect.objectContaining({ path: "/users", httpMethod: null, kind: "api", handler: "authentication" }),
      expect.objectContaining({ path: "/tags", httpMethod: null, kind: "api", handler: "tags" }),
    ]);
  });

  it("ignores a mount whose prefix is absent or not a literal", async () => {
    // Neither can contribute a prefix, and emitting them would leave a
    // non-endpoint in the route map that nothing can ever resolve.
    const routes = await routesOf(`
router.include_router(articles.router, tags=["articles"])
app.include_router(api_router, prefix=settings.api_prefix)
`);
    expect(routes).toEqual([]);
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
  path: prefix, httpMethod: null, kind: "api", handler, calls: [], middleware: [], line,
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
