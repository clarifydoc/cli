import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractClasses } from "../../../functions-classes/index.js";
import { csharpRouteExtractor } from "./aspnet.js";
import { aspnetControllerInheritance } from "./aspnet-resolver.js";
import { reconcileProjectRoutes } from "../../../route-resolvers/index.js";
import { buildImportIndex } from "../../../../core/import-index.js";
import { buildClassIndex } from "../../../../core/class-index.js";
import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";

async function analyze(files: Record<string, string>): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  for (const [filePath, src] of Object.entries(files)) {
    const tree = await parseSource(src, "csharp" as never, filePath);
    const facts: RouteFact[] = [];
    const routes = csharpRouteExtractor.extractRoutes(tree, src, filePath, facts);
    out.push({
      filePath,
      language: "csharp",
      projectId: "root",
      imports: [],
      exports: [],
      entityRelations: [],
      classes: extractClasses(tree, src, "csharp" as never),
      routes,
      routeFacts: facts,
    } as unknown as FileAnalysis);
  }
  const importIndex = buildImportIndex(out);
  const ctx: ProjectContext = {
    importIndex,
    classes: buildClassIndex(out, importIndex),
    resolveModule: () => null,
    fileOf: (p) => out.find((a) => a.filePath === p),
  };
  reconcileProjectRoutes(out, ctx, [aspnetControllerInheritance]);
  return out;
}

const BASE = `
using Microsoft.AspNetCore.Mvc;
namespace Kavita.Controllers;

[ApiController]
[Authorize]
[Route("api/[controller]")]
public class BaseApiController : ControllerBase
{
}`;

describe("aspnet-controller-inheritance", () => {
  it("gives a derived controller its base's [Route], with [controller] naming the DERIVED class (Kavita)", async () => {
    const [, series] = await analyze({
      "Api/Controllers/BaseApiController.cs": BASE,
      "Api/Controllers/SeriesController.cs": `
namespace Kavita.Controllers;
public class SeriesController(IUnitOfWork unitOfWork) : BaseApiController
{
    [HttpGet("{seriesId:int}")]
    public async Task<ActionResult<SeriesDto>> GetSeries(int seriesId) { return Ok(); }

    [AllowAnonymous]
    [HttpPost("update-match")]
    public async Task<ActionResult> UpdateMatch(UpdateMatchDto dto) { return Ok(); }
}`,
    });
    const [get, post] = series!.routes;
    expect(get).toMatchObject({ path: "/api/Series/{seriesId}", httpMethod: "GET", owner: "SeriesController", resolvedBy: "aspnet-controller-inheritance" });
    // [Authorize] inherited; the action's own [AllowAnonymous] still waives it.
    expect(get!.auth).toMatchObject({ anonymous: false, inherited: true });
    expect(post!.path).toBe("/api/Series/update-match");
    expect(post!.auth).toMatchObject({ anonymous: true });
    // [ApiController] inherited: the complex parameter binds from the body.
    expect(post!.params).toEqual([{ name: "dto", type: "UpdateMatchDto", binding: "body", inferred: true }]);
  });

  it("keeps two controllers' same-named actions apart once each has its prefix", async () => {
    const [, email, annotation] = await analyze({
      "Api/Controllers/BaseApiController.cs": BASE,
      "Api/Controllers/EmailController.cs": `public class EmailController : BaseApiController { [HttpGet("all")] public IActionResult GetEmails() => Ok(); }`,
      "Api/Controllers/AnnotationController.cs": `public class AnnotationController : BaseApiController { [HttpGet("all")] public IActionResult GetAll() => Ok(); }`,
    });
    expect(email!.routes[0]!.path).toBe("/api/Email/all");
    expect(annotation!.routes[0]!.path).toBe("/api/Annotation/all");
  });

  it("lets a controller's own [Route] win over its base's", async () => {
    const [, wtr] = await analyze({
      "Api/Controllers/BaseApiController.cs": BASE,
      "Api/Controllers/WantToReadController.cs": `
[Route("api/want-to-read")]
public class WantToReadController : BaseApiController { [HttpPost("v2")] public IActionResult Add() => Ok(); }`,
    });
    expect(wtr!.routes[0]!.path).toBe("/api/want-to-read/v2");
  });

  it("serves an abstract base's routed actions under each concrete subclass, and drops the base's own rows", async () => {
    const [rest, movie, tag] = await analyze({
      "Http/RestController.cs": `
[ApiController]
public abstract class RestController<T> : Controller
{
    [HttpGet("{id:int}")]
    public ActionResult<T> GetResourceById(int id) => Ok();
}`,
      "Api/MovieController.cs": `[Route("api/v3/movie")] public class MovieController : RestController<MovieResource> { [HttpPost] public IActionResult Add() => Ok(); }`,
      "Api/TagController.cs": `[Route("api/v3/tag")] public class TagController : RestController<TagResource> { }`,
    });
    expect(rest!.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner}`).sort()).toEqual([
      "GET /api/v3/movie/{id} MovieController",
      "GET /api/v3/tag/{id} TagController",
    ]);
    expect(movie!.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["POST /api/v3/movie"]);
    expect(tag!.routes).toEqual([]);
  });

  it("does not copy an action the subclass overrides", async () => {
    const [rest] = await analyze({
      "Http/RestController.cs": `public abstract class RestController : Controller { [HttpGet("{id}")] public virtual IActionResult Get(int id) => Ok(); }`,
      "Api/A.cs": `[Route("api/a")] public class AController : RestController { [HttpGet("{id}")] public override IActionResult Get(int id) => Ok(); }`,
    });
    expect(rest!.routes).toEqual([]);
  });

  it("marks rows whose base nobody can resolve, instead of guessing a prefix", async () => {
    const [ctl] = await analyze({
      "Api/ThingController.cs": `public class ThingController : VendorApiControllerBase { [HttpGet("things")] public IActionResult List() => Ok(); }`,
    });
    expect(ctl!.routes[0]).toMatchObject({ path: "/things", prefixUnresolved: "base:VendorApiControllerBase" });
  });

  it("leaves a controller on a framework base exactly as extracted", async () => {
    const [ctl] = await analyze({
      "Api/PlainController.cs": `public class PlainController : ControllerBase { [HttpGet("/health")] public IActionResult H() => Ok(); }`,
    });
    expect(ctl!.routes[0]).toMatchObject({ path: "/health" });
    expect(ctl!.routes[0]!.resolvedBy).toBeUndefined();
    expect(ctl!.routes[0]!.prefixUnresolved).toBeUndefined();
  });
});
