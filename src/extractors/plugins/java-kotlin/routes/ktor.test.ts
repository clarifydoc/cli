import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
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
