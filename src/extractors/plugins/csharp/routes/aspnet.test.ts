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

/**
 * The attribute layer: who may call a route, in which API versions, with what
 * parameters. Previously discarded — every route came out with an empty
 * `middleware`, no versions and no bindings, although the arguments were in
 * the parse (Tessa's Vikardaekning.API: 154 of 316 routes carry a policy,
 * none surfaced).
 */
async function fullRoutesOf(source: string): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "csharp" as any, "C.cs");
  const routes: RouteInfo[] = [];
  extractAspnetRoutes(tree.rootNode, routes);
  return routes;
}

describe("ASP.NET routes — auth attributes", () => {
  it("parses class-level [Authorize] with scheme + nameof policy, inherited by every action", async () => {
    const SRC = `namespace X;
[Authorize(AuthenticationSchemes = IstPersonale,
    Policy = nameof(Rettighed.Vikardaekke))]
[Route("api/[controller]")]
public class VikarController : ControllerBase {
    [HttpGet("list")]
    public int List() => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.middleware).toEqual([
      "Authorize(AuthenticationSchemes = IstPersonale, Policy = nameof(Rettighed.Vikardaekke))",
    ]);
    expect(r!.auth).toEqual({
      policies: ["Rettighed.Vikardaekke"],
      roles: [],
      schemes: ["IstPersonale"],
      anonymous: false,
      inherited: true,
    });
  });

  it("merges an action-level [Authorize(Roles=…)] with the class guard and splits the role list", async () => {
    const SRC = `namespace X;
[Authorize(Policy = "Read")]
public class DocsController {
    [HttpDelete("{id}")]
    [Authorize(Roles = "Admin, Editor")]
    public int Delete(int id) => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.auth).toEqual({
      policies: ["Read"],
      roles: ["Admin", "Editor"],
      schemes: [],
      anonymous: false,
      inherited: false,
    });
    expect(r!.middleware).toHaveLength(2);
  });

  it("[AllowAnonymous] on the action waives the class guard, and a positional policy string is read", async () => {
    const SRC = `namespace X;
[Authorize("Staff")]
public class PublicController {
    [HttpGet("ping")]
    [AllowAnonymous]
    public int Ping() => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.auth?.anonymous).toBe(true);
    expect(r!.auth?.policies).toEqual(["Staff"]);
    expect(r!.middleware).toEqual(["Authorize(\"Staff\")", "AllowAnonymous"]);
  });

  it("emits no auth and an empty middleware list when nothing is declared", async () => {
    const SRC = `namespace X;
public class BareController {
    [HttpGet("x")]
    public int X() => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.auth).toBeUndefined();
    expect(r!.middleware).toEqual([]);
  });
});

describe("ASP.NET routes — API versions", () => {
  it("collects class-level [ApiVersion]s, flags deprecated ones, and reads numeric literals", async () => {
    const SRC = `namespace X;
[ApiVersion("2", Deprecated = true)]
[ApiVersion(3.0)]
[Route("api/v{version:apiVersion}/[controller]")]
public class PuljeController {
    [HttpGet("myPuljer")]
    public int Get() => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.path).toBe("/api/v{version}/Pulje/myPuljer");
    expect(r!.versions).toEqual(["2", "3.0"]);
    expect(r!.deprecatedVersions).toEqual(["2"]);
  });

  it("[MapToApiVersion] narrows an action to a subset of the class versions", async () => {
    const SRC = `namespace X;
[ApiVersion("3")]
[ApiVersion("4")]
public class FravaerController {
    [HttpGet("a")]
    [MapToApiVersion("4")]
    public int A() => 1;
    [HttpGet("b")]
    public int B() => 1;
}`;
    const [a, b] = await fullRoutesOf(SRC);
    expect(a!.versions).toEqual(["4"]);
    expect(b!.versions).toEqual(["3", "4"]);
    expect(a!.deprecatedVersions).toBeUndefined();
  });

  it("leaves versions undefined for unversioned and [ApiVersionNeutral] controllers", async () => {
    const SRC = `namespace X;
public class PlainController {
    [HttpGet("a")]
    public int A() => 1;
}
[ApiVersionNeutral]
[ApiVersion("1")]
public class NeutralController {
    [HttpGet("b")]
    public int B() => 1;
}`;
    const [a, b] = await fullRoutesOf(SRC);
    expect(a!.versions).toBeUndefined();
    expect(b!.versions).toBeUndefined();
  });
});

describe("ASP.NET routes — parameter bindings", () => {
  it("reads explicit [FromX] attributes and infers route/query/body under [ApiController]", async () => {
    const SRC = `namespace X;
[ApiController]
[Route("api/institution/{institutionId}/[controller]")]
public class AktivitetController {
    [HttpPost("{id}")]
    public int Save([FromRoute] Guid institutionId, [FromBody] SaveRequest body,
        [FromQuery(Name = "q")] string? q, [FromHeader] string tenant,
        Guid id, int page = 1, List<Guid> ids = null, Filter filter = null,
        CancellationToken ct = default) => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.params).toEqual([
      { name: "institutionId", type: "Guid", binding: "route" },
      { name: "body", type: "SaveRequest", binding: "body" },
      { name: "q", type: "string?", binding: "query" },
      { name: "tenant", type: "string", binding: "header" },
      { name: "id", type: "Guid", binding: "route", inferred: true },
      { name: "page", type: "int", binding: "query", inferred: true },
      { name: "ids", type: "List<Guid>", binding: "query", inferred: true },
      { name: "filter", type: "Filter", binding: "body", inferred: true },
    ]);
  });

  it("without [ApiController] only the route-token rule is applied; the rest is null", async () => {
    const SRC = `namespace X;
public class LegacyController {
    [HttpPost("{id}")]
    public int Save(int id, Filter filter) => 1;
}`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.params).toEqual([
      { name: "id", type: "int", binding: "route", inferred: true },
      { name: "filter", type: "Filter", binding: null },
    ]);
  });

  it("omits params on a parameterless action", async () => {
    const SRC = `namespace X;
public class C { [HttpGet("x")] public int X() => 1; }`;
    const [r] = await fullRoutesOf(SRC);
    expect(r!.params).toBeUndefined();
  });
});
