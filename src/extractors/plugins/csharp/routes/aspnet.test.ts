import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractAspnetRoutes } from "./aspnet.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Regression: ASP.NET controllers reported every route as "/". The extractor
 * read the path via `attr.childForFieldName("arguments")`, but tree-sitter
 * exposes the args as an `attribute_argument_list` child (no `arguments`
 * field), so the lookup always returned null. It also never merged the
 * class-level [Route] prefix or resolved the [controller]/[action] tokens — so
 * the endpoint path was unusable for the frontend→API join. (digital-rights:
 * 167/188 API routes collapsed to "/".)
 */

async function routesOf(source: string): Promise<string[]> {
  const tree = await parseSource(source, "csharp" as any, "C.cs");
  const routes: RouteInfo[] = [];
  extractAspnetRoutes(tree.rootNode, routes);
  return routes.map((r) => `${r.httpMethod} ${r.path}`);
}

describe("ASP.NET routes — class prefix + tokens + constraints", () => {
  it("merges [Route('[controller]')] with the method template and strips constraints", async () => {
    const SRC = `namespace X;
[AllowAnonymous]
[ApiController]
[Route("[controller]")]
public class AccessReportController : ApiController {
    [HttpGet("roles/{roleId:guid}/holders")]
    public Task<int> GetRoleHolders(Guid roleId) => Task.FromResult(1);

    [HttpPost("permission-set/holders")]
    public Task<int> GetPermissionSetHolders() => Task.FromResult(1);
}`;
    const routes = await routesOf(SRC);
    expect(routes).toContain("GET /AccessReport/roles/{roleId}/holders");
    expect(routes).toContain("POST /AccessReport/permission-set/holders");
    expect(routes).toHaveLength(2);
  });

  it("resolves the api/[controller] prefix and a verb attribute with no template", async () => {
    const SRC = `namespace X;
[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase {
    [HttpGet]
    public Task<int> GetAll() => Task.FromResult(1);

    [HttpGet("{id}")]
    public Task<int> GetById(int id) => Task.FromResult(1);

    [HttpDelete("{id:int}")]
    public Task<int> Delete(int id) => Task.FromResult(1);
}`;
    const routes = await routesOf(SRC);
    expect(routes).toContain("GET /api/Users");
    expect(routes).toContain("GET /api/Users/{id}");
    expect(routes).toContain("DELETE /api/Users/{id}");
    expect(routes).toHaveLength(3);
  });

  it("ignores a named Name= argument and uses the positional template", async () => {
    const SRC = `namespace X;
[Route("api/[controller]")]
public class OrdersController {
    [HttpGet("{id}", Name = "GetOrder", Order = 2)]
    public int Get(int id) => 1;
}`;
    const routes = await routesOf(SRC);
    expect(routes).toEqual(["GET /api/Orders/{id}"]);
  });

  it("resolves the [action] token", async () => {
    const SRC = `namespace X;
[Route("api/[controller]/[action]")]
public class StatsController {
    [HttpGet]
    public int Summary() => 1;
}`;
    const routes = await routesOf(SRC);
    expect(routes).toEqual(["GET /api/Stats/Summary"]);
  });

  it("treats a method template starting with / as absolute (ignores the class prefix)", async () => {
    const SRC = `namespace X;
[Route("api/[controller]")]
public class HealthController {
    [HttpGet("/healthz")]
    public int Check() => 1;
}`;
    const routes = await routesOf(SRC);
    expect(routes).toEqual(["GET /healthz"]);
  });

  it("combines a separate method-level [Route] with a bare [HttpGet]", async () => {
    const SRC = `namespace X;
[Route("api/[controller]")]
public class LegacyController {
    [HttpGet]
    [Route("ping")]
    public int Ping() => 1;
}`;
    const routes = await routesOf(SRC);
    expect(routes).toEqual(["GET /api/Legacy/ping"]);
  });
});
