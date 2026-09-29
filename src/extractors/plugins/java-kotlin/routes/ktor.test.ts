import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractKtorRoutes } from "./ktor.js";
import { javaKotlinRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

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
            get("/users") {
                call.respond(userService.listUsers())
            }
            post("/users") {
                userService.createUser(call.receive())
            }
            route("/admin") {
                delete("/users/{id}") {
                    userService.removeUser(call.parameters["id"])
                }
            }
        }
    }
}`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /health",
      "GET /api/users",
      "POST /api/users",
      "DELETE /api/admin/users/{id}",
    ]);
    const users = routes.find((r) => r.path === "/api/users" && r.httpMethod === "GET")!;
    expect(users.calls.some((c) => /listUsers/.test(c.name ?? ""))).toBe(true);
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
        post("/users/{id}") {
          val id = call.parameters["id"]
          val q = call.request.queryParameters["q"]
          val body = call.receive<CreateUserDto>()
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
      { name: "body", type: "CreateUserDto", binding: "body" },
    ]);
    const health = routes.find((r) => r.path === "/health")!;
    expect(health.auth).toBeUndefined();
    expect(health.params).toBeUndefined();
  });
});
