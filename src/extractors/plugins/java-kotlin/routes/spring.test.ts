import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractSpringRoutes, extractSpringRoutesRegex } from "./spring.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Regression: Kotlin Spring controllers produced ZERO routes because the
 * annotation parser only understood Java's AST shape (Kotlin nests the name
 * under constructor_invocation > user_type > type_identifier, args under
 * value_arguments). dsps-server (102 Kotlin @RestControllers) reported no API
 * endpoints at all.
 */

async function routesOf(source: string, lang: "kotlin" | "java"): Promise<string[]> {
  const tree = await parseSource(source, lang as any, lang === "kotlin" ? "C.kt" : "C.java");
  const routes: RouteInfo[] = [];
  extractSpringRoutes(tree.rootNode, routes);
  return routes.map((r) => `${r.httpMethod} ${r.path}`);
}

describe("Spring routes — Kotlin (AST)", () => {
  const KOTLIN = `package x
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("app/")
class AppController {
    @GetMapping("globalVariables")
    fun getGlobalVariables(): ResponseEntity<Foo> { return service.get() }

    @PostMapping("items")
    fun create(@RequestBody dto: Dto): ResponseEntity<Dto> { return service.create(dto) }

    @DeleteMapping("items/{id}")
    fun del(@PathVariable id: Int): ResponseEntity<Boolean> { return service.del(id) }

    @RequestMapping(value = ["/balls"], method = [RequestMethod.PUT])
    fun balls(): String { return "x" }
}
`;

  it("extracts mapping annotations with the class @RequestMapping prefix merged", async () => {
    const routes = await routesOf(KOTLIN, "kotlin");
    expect(routes).toContain("GET app/globalVariables");
    expect(routes).toContain("POST app/items");
    expect(routes).toContain("DELETE app/items/{id}");
    expect(routes).toContain("PUT app/balls"); // method= attribute on @RequestMapping
    expect(routes).toHaveLength(4);
  });
});

describe("Spring routes — Java (AST regression)", () => {
  const JAVA = `package x;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class PlayerController {
    @GetMapping("/players")
    public List<Player> list() { return service.list(); }

    @PostMapping
    public Player create(@RequestBody Player u) { return service.save(u); }

    @RequestMapping(value = "/legacy", method = RequestMethod.DELETE)
    public void legacy() {}
}
`;

  it("still extracts Java Spring routes", async () => {
    const routes = await routesOf(JAVA, "java");
    expect(routes).toContain("GET /api/players");
    expect(routes).toContain("POST /api"); // no path -> class prefix only
    expect(routes).toContain("DELETE /api/legacy");
    expect(routes).toHaveLength(3);
  });
});

describe("Spring routes — regex fallback (misparsed source)", () => {
  // tree-sitter-kotlin misparses some files; the fallback scans raw source.
  const SRC = `@RestController("mobileAppController")
@RequestMapping("mobileapp/")
class AppController {
    @GetMapping("globalVariables")
    fun getGlobalVariables(): ResponseEntity<Foo> { return service.get() }

    @PostMapping(value = ["items"])
    fun create(@RequestBody dto: Dto): ResponseEntity<Dto> { return service.create(dto) }

    @GetMapping(produces = ["application/json"])
    fun noPath(): String { return "x" }
}
`;

  it("recovers routes by line-scanning the source", () => {
    const routes: RouteInfo[] = [];
    extractSpringRoutesRegex(SRC, routes);
    const sigs = routes.map((r) => `${r.httpMethod} ${r.path}`);
    expect(sigs).toContain("GET mobileapp/globalVariables");
    expect(sigs).toContain("POST mobileapp/items");
    // produces= must NOT be mistaken for a path; falls back to the class prefix.
    expect(sigs).toContain("GET mobileapp");
    expect(routes.find((r) => r.path.includes("application/json"))).toBeUndefined();
  });

  it("ignores mapping annotations in comments and string literals", () => {
    const src = [
      `// @GetMapping("/commented")`,
      `/* @PostMapping("/blockcomment") */`,
      `class C {`,
      `  val doc = "@PutMapping(/instring)"`,
      `  @GetMapping("/real")`,
      `  fun real(): String { return "" }`,
      `}`,
    ].join("\n");
    const routes: RouteInfo[] = [];
    extractSpringRoutesRegex(src, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /real"]);
  });

  it("picks the function name as handler, skipping stacked annotations", () => {
    const src = [
      `class C {`,
      `  @GetMapping("/x")`,
      `  @PreAuthorize("hasRole('ADMIN')")`,
      `  fun realHandler(): String { return "" }`,
      `}`,
    ].join("\n");
    const routes: RouteInfo[] = [];
    extractSpringRoutesRegex(src, routes);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.handler).toBe("realHandler");
  });

  it("skips @FeignClient files (outbound clients, not inbound routes)", () => {
    const src = [
      `@FeignClient(name = "svc")`,
      `interface Client {`,
      `  @GetMapping("/x")`,
      `  fun bar(): String`,
      `}`,
    ].join("\n");
    const routes: RouteInfo[] = [];
    extractSpringRoutesRegex(src, routes);
    expect(routes).toHaveLength(0);
  });
});

describe("Spring routes — confirmed-finding regressions", () => {
  it("Kotlin @RequestMapping(method=[GET, POST]) emits one route per method", async () => {
    const KOTLIN = `package x
import org.springframework.web.bind.annotation.*
@RestController
@RequestMapping("api/")
class C {
    @RequestMapping(value = ["/m"], method = [RequestMethod.GET, RequestMethod.POST])
    fun a(): String { return "" }
}
`;
    const routes = await routesOf(KOTLIN, "kotlin");
    expect(routes).toContain("GET api/m");
    expect(routes).toContain("POST api/m");
    expect(routes).toHaveLength(2);
  });

  it("Java brace-array path and brace method array", async () => {
    const JAVA = `package x;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class C {
    @GetMapping({"/x"})
    public String a() { return ""; }

    @RequestMapping(value = "/m", method = {RequestMethod.GET, RequestMethod.POST})
    public String b() { return ""; }
}
`;
    const routes = await routesOf(JAVA, "java");
    expect(routes).toContain("GET /api/x"); // positional brace-array path
    expect(routes).toContain("GET /api/m"); // brace method array, verb 1
    expect(routes).toContain("POST /api/m"); // brace method array, verb 2
    expect(routes).toHaveLength(3);
  });

  it("Kotlin @FeignClient interface methods are not inbound routes (AST path)", async () => {
    const KOTLIN = `package x
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.*
@FeignClient(name = "svc")
interface Client {
    @GetMapping("/x")
    fun bar(): String
}
`;
    const routes = await routesOf(KOTLIN, "kotlin");
    expect(routes).toHaveLength(0);
  });

  it("empty path @GetMapping(\"\") falls back to the class prefix", async () => {
    const JAVA = `package x;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api")
public class C {
    @GetMapping("")
    public String root() { return ""; }
}
`;
    const routes = await routesOf(JAVA, "java");
    expect(routes).toEqual(["GET /api"]);
  });
});

/**
 * The attribute layer: Spring Security guards (class-level ones inherited),
 * and where each handler parameter binds from — declared by annotation, or
 * by Spring's defaults (simple → query, complex → implicit @ModelAttribute
 * form, framework types → injected).
 */
async function fullRoutesOf(source: string, lang: "kotlin" | "java"): Promise<RouteInfo[]> {
  const tree = await parseSource(source, lang as any, lang === "java" ? "A.java" : "A.kt");
  const routes: RouteInfo[] = [];
  extractSpringRoutes(tree.rootNode, routes);
  return routes;
}

describe("Spring routes — guards and parameter bindings", () => {
  it("merges class-level @PreAuthorize with action-level @Secured/@RolesAllowed and reads every binding annotation", async () => {
    const SRC = `package x;
@RestController
@RequestMapping("/api/players")
@PreAuthorize("hasRole('ADMIN')")
public class PlayerController {
  @PostMapping("/{id}")
  @Secured({"ROLE_A", "ROLE_B"})
  public ResponseEntity<Player> save(@PathVariable Long id, @RequestBody CreatePlayerDto dto,
      @RequestParam(name = "q", required = false) String q, @RequestHeader("X-T") String t,
      @Valid @ModelAttribute Form f, Principal p, HttpServletRequest r, Filter filter, int page) { return null; }
}`;
    const [r] = await fullRoutesOf(SRC, "java");
    expect(r!.middleware).toEqual(["PreAuthorize(\"hasRole('ADMIN')\")", 'Secured({"ROLE_A", "ROLE_B"})']);
    expect(r!.auth).toEqual({
      policies: ["hasRole('ADMIN')"],
      roles: ["ROLE_A", "ROLE_B"],
      schemes: [],
      anonymous: false,
      inherited: false,
    });
    expect(r!.params).toEqual([
      { name: "id", type: "Long", binding: "route" },
      { name: "dto", type: "CreatePlayerDto", binding: "body" },
      { name: "q", type: "String", binding: "query" },
      { name: "t", type: "String", binding: "header" },
      { name: "f", type: "Form", binding: "form" },
      { name: "p", type: "Principal", binding: "services", inferred: true },
      { name: "r", type: "HttpServletRequest", binding: "services", inferred: true },
      { name: "filter", type: "Filter", binding: "form", inferred: true },
      { name: "page", type: "int", binding: "query", inferred: true },
    ]);
  });

  it("marks a class guard as inherited and @PermitAll as anonymous", async () => {
    const SRC = `package x;
@RestController
@PreAuthorize("isAuthenticated()")
public class C {
  @GetMapping("/a") public int a() { return 1; }
  @GetMapping("/b") @PermitAll public int b() { return 1; }
}`;
    const [a, b] = await fullRoutesOf(SRC, "java");
    expect(a!.auth).toMatchObject({ policies: ["isAuthenticated()"], inherited: true, anonymous: false });
    expect(b!.auth).toMatchObject({ policies: ["isAuthenticated()"], inherited: false, anonymous: true });
    expect(a!.params).toBeUndefined();
  });

  it("reads Kotlin parameter annotations from the preceding parameter_modifiers sibling", async () => {
    const SRC = `package x
class PlayerController {
  @PostMapping("/{id}")
  @PreAuthorize("hasRole('ADMIN')")
  fun save(@PathVariable id: Long, @RequestBody dto: CreatePlayerDto, @RequestParam(name = "q") q: String?): Player = TODO()
}`;
    const [r] = await fullRoutesOf(SRC, "kotlin");
    expect(r!.auth?.policies).toEqual(["hasRole('ADMIN')"]);
    expect(r!.params).toEqual([
      { name: "id", type: "Long", binding: "route" },
      { name: "dto", type: "CreatePlayerDto", binding: "body" },
      { name: "q", type: "String?", binding: "query" },
    ]);
  });

  it("emits no auth and no params when nothing is declared", async () => {
    const SRC = `package x;
@RestController
public class C { @GetMapping("/a") public int a() { return 1; } }`;
    const [r] = await fullRoutesOf(SRC, "java");
    expect(r!.auth).toBeUndefined();
    expect(r!.middleware).toEqual([]);
  });
});

describe("Spring WebFlux functional endpoints", () => {
  it("reads route().GET/POST with method-reference handlers and nest prefixes", async () => {
    const src = `package x;
class PolicyEndpoint {
  public RouterFunction<ServerResponse> endpoint() {
    return SpringdocRouteBuilder.route()
        .GET("/policies/{name}/configs/{group}", this::getPolicyConfigByGroup, builder -> builder.operationId("get"))
        .PUT("/policies/{name}/configs/{group}", this::updatePolicyConfigByGroup, builder -> builder.operationId("update"))
        .build();
  }
  public RouterFunction<ServerResponse> pages() {
    return RouterFunctions.route()
        .GET(consolePagePredicate, request -> ServerResponse.ok().bodyValue(html))
        .nest(RequestPredicates.path("/apis/v1"), b -> b.POST("/attachments", request -> attachmentService.upload(request)))
        .build();
  }
}`;
    const tree = await parseSource(src, "java" as any, "PolicyEndpoint.java");
    const routes: RouteInfo[] = [];
    extractSpringRoutes(tree.rootNode, routes);
    routes.sort((a, b) => a.line - b.line); // a chain is walked outermost-first
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /policies/{name}/configs/{group} -> getPolicyConfigByGroup",
      "PUT /policies/{name}/configs/{group} -> updatePolicyConfigByGroup",
      "POST /apis/v1/attachments -> null",
    ]);
    expect(routes[2]!.calls.map((c) => c.name)).toContain("attachmentService.upload");
  });

  it("serves a path-less verb at its nest's path, and a method's routes under the nest that calls it (real-repo FP)", async () => {
    const src = `package x;
class MyClubsEndpoint {
  public RouterFunction<ServerResponse> endpoint() {
    return SpringdocRouteBuilder.route()
        .nest(RequestPredicates.path("/managers/{username}"), managerScopedApis())
        .nest(path("/clubs"), () -> route().GET(this::listMyClubs, builder -> builder.operationId("ListMyClubs"))
            .POST(this::createMyClub, builder -> builder.operationId("CreateMyClub"))
            .build(), builder -> builder.operationId("MyClubs"))
        .build();
  }
  Supplier<RouterFunction<ServerResponse>> managerScopedApis() {
    return () -> SpringdocRouteBuilder.route()
        .GET("/fixtures", this::listFixtures, builder -> builder.operationId("ListFixtures"))
        .build();
  }
}`;
    const tree = await parseSource(src, "java" as any, "MyClubsEndpoint.java");
    const routes: RouteInfo[] = [];
    extractSpringRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`).sort()).toEqual([
      "GET /clubs -> listMyClubs",
      "GET /managers/{username}/fixtures -> listFixtures",
      "POST /clubs -> createMyClub",
    ]);
  });

  it("reads a path a constant of the file holds, its value on the next line (real-repo FP)", async () => {
    const src = `package x;
class SubscriptionRouter {
    public static final String UNSUBSCRIBE_PATTERN =
            "/apis/api.league.example.com/v1alpha1/subscriptions/{name}/unsubscribe";

    RouterFunction<ServerResponse> router() {
        return SpringdocRouteBuilder.route()
            .GET(UNSUBSCRIBE_PATTERN, this::unsubscribe, builder -> builder.operationId("Unsubscribe"))
            .build();
    }
}`;
    const tree = await parseSource(src, "java" as any, "SubscriptionRouter.java");
    const routes: RouteInfo[] = [];
    extractSpringRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /apis/api.league.example.com/v1alpha1/subscriptions/{name}/unsubscribe -> unsubscribe",
    ]);
  });
});

describe("Halo runtime routes", () => {
  it("prefixes a CustomEndpoint's functional routes with its group/version, Halo's default when not overridden", async () => {
    const src = `package x;
class GameEndpoint implements CustomEndpoint {
  public RouterFunction<ServerResponse> endpoint() {
    return SpringdocRouteBuilder.route().GET("/games/{name}/content", this::fetchContent, b -> b.tag("t")).build();
  }
}
class ThemeEndpoint implements CustomEndpoint {
  public RouterFunction<ServerResponse> endpoint() {
    return SpringdocRouteBuilder.route().GET("themes", this::list, b -> b.tag("t")).build();
  }
  @Override
  public GroupVersion groupVersion() { return GroupVersion.parseAPIVersion("api.halo.run/v1alpha1"); }
}`;
    const tree = await parseSource(src, "java" as any, "E.java");
    const routes: RouteInfo[] = [];
    extractSpringRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /apis/api.console.halo.run/v1alpha1/games/{name}/content",
      "GET /apis/api.halo.run/v1alpha1/themes",
    ]);
  });

  it("generates CRUD routes from @GVK, resolving constants and the core group", async () => {
    const { extractHaloExtensionRoutes } = await import("./halo.js");
    const routes: RouteInfo[] = [];
    extractHaloExtensionRoutes(`@GVK(group = GROUP, version = VERSION, kind = "Attachment", plural = "attachments", singular = "attachment")
public class Attachment extends AbstractExtension {
  public static final String GROUP = "storage.halo.run";
  public static final String VERSION = "v1alpha1";
}
@GVK(group = "", version = "v1alpha1", kind = "Menu", plural = "menus", singular = "menu")
class Menu {}`, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /apis/storage.halo.run/v1alpha1/attachments", "POST /apis/storage.halo.run/v1alpha1/attachments",
      "GET /apis/storage.halo.run/v1alpha1/attachments/{name}", "PUT /apis/storage.halo.run/v1alpha1/attachments/{name}",
      "PATCH /apis/storage.halo.run/v1alpha1/attachments/{name}", "DELETE /apis/storage.halo.run/v1alpha1/attachments/{name}",
      "GET /api/v1alpha1/menus", "POST /api/v1alpha1/menus", "GET /api/v1alpha1/menus/{name}", "PUT /api/v1alpha1/menus/{name}",
      "PATCH /api/v1alpha1/menus/{name}", "DELETE /api/v1alpha1/menus/{name}",
    ]);
  });
});

describe("Spring routes — several paths on one mapping", () => {
  it("emits one route per path, in Java and Kotlin", async () => {
    const java = await routesOf(`@RestController @RequestMapping("/games")
class C {
  @GetMapping({"/featured", "/pinned"}) List<Game> top() { return s.top(); }
  @RequestMapping(value = {"/a", "/b"}, method = {RequestMethod.GET, RequestMethod.POST}) void ab() {}
}`, "java");
    expect(java.sort()).toEqual(["GET /games/a", "GET /games/b", "GET /games/featured", "GET /games/pinned", "POST /games/a", "POST /games/b"]);
    const kotlin = await routesOf(`@RestController
class K {
  @GetMapping(value = ["/x", "/y"])
  fun xy(): String { return "" }
}`, "kotlin");
    expect(kotlin.sort()).toEqual(["GET /x", "GET /y"]);
  });
});

describe("a mapping that starts with a configuration placeholder", () => {
  it("keeps the known tail and says the prefix is unresolved (real-repo FP: the caller's URL never matched)", async () => {
    const { parseSource } = await import("../../../../parsers/parser-manager.js");
    const { javaKotlinRouteExtractor } = await import("./index.js");
    const src = `package x;
@RestController
public class ClubTypesController {
  @GetMapping(value = "\${service.prefix}public/club-types", produces = "application/json")
  public List<String> clubTypes() { return List.of(); }
  @GetMapping("\${service.prefix}")
  public String root() { return ""; }
}`;
    const tree = await parseSource(src, "java" as never, "ClubTypesController.java");
    const routes = javaKotlinRouteExtractor.extractRoutes(tree, src, "ClubTypesController.java");
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.prefixUnresolved}`)).toEqual([
      "GET /public/club-types property:\${service.prefix}",
      "GET / property:\${service.prefix}",
    ]);
  });
});
