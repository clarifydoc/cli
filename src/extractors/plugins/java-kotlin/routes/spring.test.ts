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

    @RequestMapping(value = ["/things"], method = [RequestMethod.PUT])
    fun things(): String { return "x" }
}
`;

  it("extracts mapping annotations with the class @RequestMapping prefix merged", async () => {
    const routes = await routesOf(KOTLIN, "kotlin");
    expect(routes).toContain("GET app/globalVariables");
    expect(routes).toContain("POST app/items");
    expect(routes).toContain("DELETE app/items/{id}");
    expect(routes).toContain("PUT app/things"); // method= attribute on @RequestMapping
    expect(routes).toHaveLength(4);
  });
});

describe("Spring routes — Java (AST regression)", () => {
  const JAVA = `package x;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.list(); }

    @PostMapping
    public User create(@RequestBody User u) { return service.save(u); }

    @RequestMapping(value = "/legacy", method = RequestMethod.DELETE)
    public void legacy() {}
}
`;

  it("still extracts Java Spring routes", async () => {
    const routes = await routesOf(JAVA, "java");
    expect(routes).toContain("GET /api/users");
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
@RequestMapping("/api/users")
@PreAuthorize("hasRole('ADMIN')")
public class UserController {
  @PostMapping("/{id}")
  @Secured({"ROLE_A", "ROLE_B"})
  public ResponseEntity<User> save(@PathVariable Long id, @RequestBody CreateUserDto dto,
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
      { name: "dto", type: "CreateUserDto", binding: "body" },
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
class UserController {
  @PostMapping("/{id}")
  @PreAuthorize("hasRole('ADMIN')")
  fun save(@PathVariable id: Long, @RequestBody dto: CreateUserDto, @RequestParam(name = "q") q: String?): User = TODO()
}`;
    const [r] = await fullRoutesOf(SRC, "kotlin");
    expect(r!.auth?.policies).toEqual(["hasRole('ADMIN')"]);
    expect(r!.params).toEqual([
      { name: "id", type: "Long", binding: "route" },
      { name: "dto", type: "CreateUserDto", binding: "body" },
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
