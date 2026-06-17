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
