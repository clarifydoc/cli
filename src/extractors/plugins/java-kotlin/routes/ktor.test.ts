import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractKtorRoutes } from "./ktor.js";
import { javaKotlinRouteExtractor } from "./index.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact, type RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import { ktorRouteFnResolver } from "./ktor.js";

/** Ktor's routing DSL produced zero routes before this extractor. */
async function routesOf(source: string): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "kotlin" as any, "Routing.kt");
  return javaKotlinRouteExtractor.extractRoutes(tree, source, "Routing.kt");
}

describe("Ktor routing DSL", () => {
  it("extracts verbs with route(...) prefix composition and lambda calls", async () => {
    const SRC = `package x

import io.ktor.server.routing.*
import io.ktor.server.response.*

fun Application.configureRouting() {
    routing {
        get("/health") {
            call.respondText("OK")
        }
        route("/api") {
            get("/players") {
                call.respond(playerService.listPlayers())
            }
            post("/players") {
                playerService.createPlayer(call.receive())
            }
            route("/admin") {
                delete("/players/{id}") {
                    playerService.removePlayer(call.parameters["id"])
                }
            }
        }
    }
}`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /health",
      "GET /api/players",
      "POST /api/players",
      "DELETE /api/admin/players/{id}",
    ]);
    const players = routes.find((r) => r.path === "/api/players" && r.httpMethod === "GET")!;
    expect(players.calls.some((c) => /listPlayers/.test(c.name ?? ""))).toBe(true);
  });

  it("handles path-less verbs inside a route block", async () => {
    const SRC = `import io.ktor.server.routing.*

fun Application.module() {
    routing {
        route("/ping") {
            get {
                call.respondText("pong")
            }
        }
    }
}`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /ping"]);
  });

  it("ignores generic get(...) helpers outside routing blocks and non-ktor files", async () => {
    const KTOR_FILE = `import io.ktor.server.routing.*

fun helper(map: Map<String, String>): String? {
    return get("some-key")
}`;
    expect(await routesOf(KTOR_FILE)).toEqual([]);

    const PLAIN = `fun main() {
    routing {
        get("/not-ktor") { }
    }
}`;
    // No io.ktor import — the DSL walk never runs.
    expect(await routesOf(PLAIN)).toEqual([]);
  });
});

describe("Ktor — authenticate blocks and call.* bindings", () => {
  it("an enclosing authenticate(\"jwt\") guards the routes inside it; the lambda's call.* reads are the params", async () => {
    const SRC = `package x
import io.ktor.server.routing.*
fun Application.module() {
  routing {
    authenticate("auth-jwt") {
      route("/api") {
        post("/players/{id}") {
          val id = call.parameters["id"]
          val q = call.request.queryParameters["q"]
          val body = call.receive<CreatePlayerDto>()
          call.respond(body)
        }
      }
    }
    get("/health") { call.respondText("OK") }
  }
}`;
    const tree = await parseSource(SRC, "kotlin" as any, "A.kt");
    const routes: RouteInfo[] = [];
    extractKtorRoutes(tree.rootNode, routes);
    const post = routes.find((r) => r.httpMethod === "POST")!;
    expect(post.auth).toEqual({ policies: [], roles: [], schemes: ["auth-jwt"], anonymous: false, inherited: true });
    expect(post.middleware).toEqual(['authenticate("auth-jwt")']);
    expect(post.params).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "q", type: null, binding: "query" },
      { name: "body", type: "CreatePlayerDto", binding: "body" },
    ]);
    const health = routes.find((r) => r.path === "/health")!;
    expect(health.auth).toBeUndefined();
    expect(health.params).toBeUndefined();
  });
});

describe("Ktor route functions installed by name", () => {
  const fileOf = async (filePath: string, src: string): Promise<FileAnalysis> => {
    const tree = await parseSource(src, "kotlin" as any, filePath);
    const facts: RouteFact[] = [];
    const routes = javaKotlinRouteExtractor.extractRoutes(tree, src, filePath, facts);
    return { ...createEmptyAnalysis(filePath, "kotlin"), routes, routeFacts: facts };
  };

  it("serves a Route extension's routes under the block that installs it, through relaying extensions", async () => {
    const app = await fileOf("src/Application.kt", `package app
import io.ktor.server.routing.*
fun Application.module() {
    routing {
        get("/health") { call.respondText("OK") }
        route("/api") {
            authenticate("jwt") {
                playerRoutes()
            }
            adminRoutes()
        }
    }
}`);
    const players = await fileOf("src/routes/PlayerRoutes.kt", `package app.routes
import io.ktor.server.routing.*
fun Route.playerRoutes() {
    route("/players") {
        get { call.respond(repo.all()) }
        post("/{id}/lock") { helper() }
    }
}
fun Route.adminRoutes() {
    route("/admin") {
        reportRoutes()
    }
}
fun Route.reportRoutes() {
    get("/reports") { call.respond(1) }
}`);
    expect(players.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner}`)).toEqual([
      "GET /players fn:playerRoutes",
      "POST /players/{id}/lock fn:playerRoutes",
      "GET /reports fn:reportRoutes",
    ]);
    ktorRouteFnResolver.resolve([app, players], {} as ProjectContext);
    expect([app, players].flatMap((a) => a.routes).map((r) => `${r.httpMethod} ${r.path}${r.auth ? ` auth=${r.auth.schemes.join(",")}` : ""}`)).toEqual([
      "GET /health",
      "GET /api/players auth=jwt",
      "POST /api/players/{id}/lock auth=jwt",
      "GET /api/admin/reports",
    ]);
  });
});

describe("Jetpack Compose navigation", () => {
  it("reads composable / dialog destinations, string and type-safe, and the page each renders", async () => {
    const routes = await routesOf(`package app
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable

@Composable
fun AppNav(navController: NavHostController) {
    NavHost(navController, startDestination = "home") {
        composable("home") { HomeScreen(onOpen = { id -> navController.navigate("profile/$id") }) }
        composable(route = "profile/{playerId}") { entry ->
            val id = entry.arguments?.getString("playerId")
            ProfileScreen(playerId = id)
        }
        composable<Settings> { SettingsScreen() }
        dialog("confirm") { ConfirmDialog() }
        navigation(startDestination = "a", route = "wizard") {
            composable("a") { StepA() }
        }
    }
}`);
    expect(routes.map((r) => `${r.kind} ${r.path} ${r.componentPath}`)).toEqual([
      "frontend home HomeScreen",
      "frontend profile/{playerId} ProfileScreen",
      "frontend Settings SettingsScreen",
      "frontend confirm ConfirmDialog",
      "frontend a StepA",
    ]);
  });
});
