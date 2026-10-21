import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javaKotlinRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(source: string, lang: "java" | "kotlin" = "java"): Promise<RouteInfo[]> {
  const file = lang === "java" ? "App.java" : "App.kt";
  const tree = await parseSource(source, lang as any, file);
  return javaKotlinRouteExtractor.extractRoutes(tree, source, file);
}
const rows = (routes: RouteInfo[]) => routes.map((r) => `${r.httpMethod} ${r.path}${r.handler ? ` → ${r.handler}` : ""}`);
const params = (r: RouteInfo | undefined) => (r?.params ?? []).map((p) => `${p.binding}:${p.name}${p.type ? `:${p.type}` : ""}`);

describe("Javalin routes", () => {
  it("reads receiver verbs, the ApiBuilder's nested paths, crud and fluent chains", async () => {
    const routes = await routesOf(`
import io.javalin.Javalin;
import static io.javalin.apibuilder.ApiBuilder.*;

public class App {
  public static void main(String[] args) {
    Javalin app = Javalin.create(config -> {
      config.router.apiBuilder(() -> {
        path("api/players", () -> {
          get(PlayerController::getAll);
          post(PlayerController::create);
          path("<id>", () -> {
            get(PlayerController::getOne);
            delete(ctx -> repo.remove(ctx.pathParam("id")));
          });
        });
        crud("cars/{car-id}", new CarController());
      });
    }).start(7070);
    app.get("/health", ctx -> ctx.result("ok"));
    app.post("/balls", ctx -> {
      Ball ball = ctx.bodyAsClass(Ball.class);
      String token = ctx.header("X-Token");
      service.save(ball, ctx.queryParam("dry"));
    });
    Javalin.create().get("/a", ctx -> a()).post("/b", ctx -> b());
    cache.put("/not-a-route", value);
    String v = map.get("/also-not");
  }
}`);
    expect(rows(routes)).toEqual([
      "GET /api/players → PlayerController.getAll",
      "POST /api/players → PlayerController.create",
      "GET /api/players/{id} → PlayerController.getOne",
      "DELETE /api/players/{id}",
      "GET /cars → CarController.getAll",
      "POST /cars → CarController.create",
      "GET /cars/{car-id} → CarController.getOne",
      "PATCH /cars/{car-id} → CarController.update",
      "DELETE /cars/{car-id} → CarController.delete",
      "GET /health",
      "POST /balls",
      "GET /a",
      "POST /b",
    ]);
    expect(params(routes.find((r) => r.path === "/balls"))).toEqual(["header:X-Token", "query:dry", "body:body:Ball"]);
    expect(params(routes[3])).toEqual(["route:id"]);
    expect(routes.find((r) => r.path === "/balls")!.calls.map((c) => c.name)).toContain("service.save");
  });

  it("reads Kotlin trailing lambdas and callable references", async () => {
    const routes = await routesOf(`
import io.javalin.Javalin
import io.javalin.apibuilder.ApiBuilder.*

fun main() {
    val app = Javalin.create().start(7070)
    app.get("/players/{id}") { ctx -> ctx.json(repo.find(ctx.pathParam("id"))) }
    app.post("/players", PlayerController::create)
    app.routes {
        path("admin") {
            get(AdminController::stats)
        }
    }
}`, "kotlin");
    expect(rows(routes)).toEqual(["GET /players/{id}", "POST /players → PlayerController.create", "GET /admin → AdminController.stats"]);
    expect(params(routes[0])).toEqual(["route:id"]);
  });
});

describe("Spark routes", () => {
  it("reads statically imported verbs, path groups and the request reads", async () => {
    const routes = await routesOf(`
import static spark.Spark.*;

public class Main {
  public static void main(String[] args) {
    port(4567);
    get("/hello", (req, res) -> "Hello");
    post("/players/:id", (req, res) -> {
      String id = req.params(":id");
      String q = req.queryParams("q");
      return players.update(id, req.body());
    });
    path("/api", () -> {
      before("/*", (q, a) -> log());
      get("/balls", BallRoutes::list);
      path("/v2", () -> put("/balls/:id", BallRoutes::update));
    });
    staticFiles.location("/public");
  }
}`);
    expect(rows(routes)).toEqual(["GET /hello", "POST /players/:id", "GET /api/balls → BallRoutes.list", "PUT /api/v2/balls/:id → BallRoutes.update"]);
    expect(params(routes[1])).toEqual(["route:id", "query:q", "body:body"]);
  });

  it("reads nothing in a file that imports neither framework", async () => {
    expect(await routesOf(`class A { void m() { get("/x", (a, b) -> 1); app.get("/y", ctx -> 2); } }`)).toEqual([]);
  });
});
