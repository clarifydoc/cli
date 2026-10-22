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
      "Api/BallController.cs": `public class BallController : VendorApiControllerBase { [HttpGet("balls")] public IActionResult List() => Ok(); }`,
    });
    expect(ctl!.routes[0]).toMatchObject({ path: "/balls", prefixUnresolved: "base:VendorApiControllerBase" });
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

/** Radarr's own routing attributes, as declared in `src/Radarr.Http`. */
const RADARR_ATTRS = {
  "Radarr.Http/VersionedApiControllerAttribute.cs": `
namespace Radarr.Http
{
    public class VersionedApiControllerAttribute : Attribute, IRouteTemplateProvider, IEnableCorsAttribute, IApiBehaviorMetadata
    {
        public const string API_CORS_POLICY = "ApiCorsPolicy";
        public const string CONTROLLER_RESOURCE = "[controller]";

        public VersionedApiControllerAttribute(int version, string resource = CONTROLLER_RESOURCE)
        {
            Resource = resource;
            Template = $"api/v{version}/{resource}";
            PolicyName = API_CORS_POLICY;
        }

        public string Resource { get; }
        public string Template { get; }
        public int? Order => 2;
        public string Name { get; set; }
        public string PolicyName { get; set; }
    }

    public class V3ApiControllerAttribute : VersionedApiControllerAttribute
    {
        public V3ApiControllerAttribute(string resource = "[controller]")
            : base(3, resource)
        {
        }
    }
}`,
  "Radarr.Http/REST/Attributes/RestPutByIdAttribute.cs": `
[AttributeUsage(AttributeTargets.Method)]
public class RestPutByIdAttribute : HttpPutAttribute
{
    public RestPutByIdAttribute()
        : base("{id:int?}")
    {
    }
}`,
  "Radarr.Http/REST/Attributes/RestDeleteByIdAttribute.cs": `
public class RestDeleteByIdAttribute : HttpDeleteAttribute
{
    public RestDeleteByIdAttribute() : base("{id:int}") { }
}`,
  "Radarr.Http/REST/Attributes/RestPostByIdAttribute.cs": `
public class RestPostByIdAttribute : HttpPostAttribute
{
}`,
  "Radarr.Http/REST/Attributes/RestGetByIdAttribute.cs": `
public class RestGetByIdAttribute : Attribute, IActionHttpMethodProvider, IRouteTemplateProvider
{
    public IEnumerable<string> HttpMethods => new[] { "GET" };
    public string Template => "{id:int}";
    public int? Order => 0;
    public string Name { get; }
}`,
  "Radarr.Http/REST/RestController.cs": `
public abstract class RestController<TResource> : Controller
{
    [RestGetById]
    public virtual ActionResult<TResource> GetResourceByIdWithErrorHandler(int id) { return GetResourceById(id); }

    protected abstract TResource GetResourceById(int id);
}`,
};

describe("project routing attributes (Radarr)", () => {
  const rows = (a: FileAnalysis | undefined) => (a?.routes ?? []).map((r) => `${r.httpMethod} ${r.path} ${r.owner}`).sort();

  it("evaluates [V3ApiController] through its constructor chain, and custom verb attributes through their base call", async () => {
    const out = await analyze({
      ...RADARR_ATTRS,
      "Radarr.Api.V3/Tags/TagController.cs": `
[V3ApiController]
public class TagController : RestController<TagResource>
{
    [HttpGet]
    public List<TagResource> GetAll() => null;

    [RestPostById]
    [Consumes("application/json")]
    public ActionResult<TagResource> Create([FromBody] TagResource resource) => null;

    [RestPutById]
    public ActionResult<TagResource> Update(TagResource resource) => null;

    [RestDeleteById]
    public void DeleteTag(int id) { }

    [NonAction]
    public void Handle(TagsUpdatedEvent message) { }
}`,
      "Radarr.Api.V3/Movies/MovieLookupController.cs": `
[V3ApiController("movie/lookup")]
public class MovieLookupController : RestController<MovieResource>
{
    [HttpGet("tmdb")]
    public object SearchByTmdbId(int tmdbId) => null;
}`,
    });
    const byPath = (p: string) => out.find((a) => a.filePath === p);
    expect(rows(byPath("Radarr.Api.V3/Tags/TagController.cs"))).toEqual([
      "DELETE /api/v3/Tag/{id} TagController",
      "GET /api/v3/Tag TagController",
      "POST /api/v3/Tag TagController",
      "PUT /api/v3/Tag/{id} TagController",
    ]);
    expect(rows(byPath("Radarr.Api.V3/Movies/MovieLookupController.cs"))).toEqual(["GET /api/v3/movie/lookup/tmdb MovieLookupController"]);
    // The abstract base's [RestGetById] action is served under each concrete controller.
    expect(rows(byPath("Radarr.Http/REST/RestController.cs"))).toEqual([
      "GET /api/v3/Tag/{id} TagController",
      "GET /api/v3/movie/lookup/{id} MovieLookupController",
    ]);
    // `IApiBehaviorMetadata` is [ApiController] behaviour: the complex parameter binds from the body.
    const put = byPath("Radarr.Api.V3/Tags/TagController.cs")!.routes.find((r) => r.httpMethod === "PUT")!;
    expect(put.params).toEqual([{ name: "resource", type: "TagResource", binding: "body", inferred: true }]);
    // `{id:int?}` is optional: the update also answers the collection path a settings page saves to.
    expect(put.aliases).toEqual(["/api/v3/Tag"]);
    expect(put.resolvedBy).toBe("aspnet-controller-inheritance");
  });

  it("marks a controller whose project attribute builds its template in a way nobody can evaluate", async () => {
    const [, ctl] = await analyze({
      "Http/DynamicRouteAttribute.cs": `
public class DynamicRouteAttribute : Attribute, IRouteTemplateProvider
{
    public DynamicRouteAttribute(int version) { Template = Routes.Build(version); }
    public string Template { get; }
}`,
      "Api/BallController.cs": `[DynamicRoute(2)] public class BallController : ControllerBase { [HttpGet("balls")] public IActionResult List() => Ok(); }`,
    });
    expect(ctl!.routes[0]).toMatchObject({ path: "/balls", prefixUnresolved: "attribute:DynamicRoute" });
  });

  it("refuses a verb attribute whose template cannot be evaluated, and ignores attributes that do not route", async () => {
    const [, ctl] = await analyze({
      "Http/Attrs.cs": `
public class OddPutAttribute : HttpPutAttribute
{
    public OddPutAttribute() : base(Templates.Next()) { }
}
public class SkipValidationAttribute : ActionFilterAttribute
{
}`,
      "Api/BallController.cs": `
[Route("api/balls")]
public class BallController : ControllerBase
{
    [OddPut]
    public IActionResult Put(int id) => Ok();

    [SkipValidation]
    public IActionResult Helper() => Ok();

    [HttpGet]
    public IActionResult List() => Ok();
}`,
    });
    expect(rows(ctl)).toEqual(["GET /api/balls BallController"]);
  });
});


describe("conventional routing", () => {
  const rows = (analyses: FileAnalysis[]) =>
    analyses.flatMap((a) => a.routes.map((r) => `${r.httpMethod ?? "ANY"} ${r.path} ${r.owner}.${r.handler}`)).sort();

  it("serves an MVC controller's plain actions through the registered pattern, overloads and areas included", async () => {
    const out = await analyze({
      "Web/Program.cs": `
var app = builder.Build();
app.MapControllerRoute(name: "areas", pattern: "{area:exists}/{controller=Home}/{action=Index}/{id?}");
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");`,
      "Web/Controllers/HomeController.cs": `
public class HomeController : Controller {
  public IActionResult Index() => View();
  public IActionResult Edit(int id) => View();
  [HttpPost] public IActionResult Edit(int id, EditModel m) => Ok();
  [ActionName("Remove")] [HttpPost] public IActionResult Delete(int id) => Ok();
  [NonAction] public void Helper() {}
  private void Hidden() {}
  public static void Util() {}
  protected override void Dispose(bool disposing) {}
}`,
      "Web/Areas/Admin/Controllers/PlayersController.cs": `
[Area("Admin")]
public class PlayersController : Controller { public IActionResult List() => View(); }`,
      "Web/Controllers/ApiBallController.cs": `
[ApiController] [Route("api/balls")]
public class ApiBallController : ControllerBase { [HttpGet] public int Get() => 1; public int NotRouted() => 2; }`,
    });
    expect(rows(out)).toEqual([
      "ANY /Admin/Players/List PlayersController.List",
      "ANY /Home/Edit/{id} HomeController.Edit",
      "ANY /Home/Index HomeController.Index",
      "GET /api/balls ApiBallController.Get",
      "POST /Home/Edit/{id} HomeController.Edit",
      "POST /Home/Remove/{id} HomeController.Delete",
    ]);
  });

  it("reads MVC 5 MapRoute defaults and area registrations, and Web API 2 verbs by name", async () => {
    const out = await analyze({
      "Site/App_Start/RouteConfig.cs": `
public class RouteConfig { public static void RegisterRoutes(RouteCollection routes) {
  routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}", defaults: new { controller = "Home", action = "Index", id = UrlParameter.Optional });
} }`,
      "Site/App_Start/WebApiConfig.cs": `
public static class WebApiConfig { public static void Register(HttpConfiguration config) {
  config.Routes.MapHttpRoute("DefaultApi", "api/{controller}/{id}", new { id = RouteParameter.Optional });
} }`,
      "Site/Areas/Shop/ShopAreaRegistration.cs": `
public class ShopAreaRegistration : AreaRegistration { public override void RegisterArea(AreaRegistrationContext context) {
  context.MapRoute("Shop_default", "Shop/{controller}/{action}/{id}", new { action = "Index", id = UrlParameter.Optional });
} }`,
      "Site/Areas/Shop/Controllers/GarageController.cs": `public class GarageController : Controller { public ActionResult Add(int id) { return View(); } }`,
      "Site/Controllers/CarsController.cs": `public class CarsController : Controller { public ActionResult Index() { return View(); } }`,
      "Site/Controllers/PartsController.cs": `
using System.Web.Http;
public class PartsController : ApiController {
  public string GetPart(int id) { return null; }
  public void PostPart(string p) { }
  [HttpDelete] public void Remove(int id) { }
  [Route("api/parts/{id}/stock")] public int Stock(int id) { return 0; }
}`,
    });
    expect(rows(out)).toEqual([
      "ANY /Cars/Index CarsController.Index",
      "ANY /Shop/Garage/Add/{id} GarageController.Add",
      "DELETE /api/Parts/{id} PartsController.Remove",
      "GET /api/Parts/{id} PartsController.GetPart",
      "POST /api/Parts PartsController.PostPart",
      "POST /api/parts/{id}/stock PartsController.Stock",
    ]);
  });

  it("serves a base controller's actions under each subclass, its overrides included", async () => {
    const out = await analyze({
      "Web/Program.cs": `app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");`,
      "Web/Controllers/CrudController.cs": `
public abstract class CrudController : Controller {
  public IActionResult List() => View();
  public virtual IActionResult Details(int id) => View();
  [HttpPost] public IActionResult Delete(int id) => Ok();
  public override void OnActionExecuting(ActionExecutingContext c) { }
}
public class PartsController : CrudController {
  public override IActionResult Details(int id) => View("Part");
  public IActionResult Export() => File(new byte[0], "text/csv");
}
public class CarsController : CrudController { }`,
    });
    expect(rows(out)).toEqual([
      "ANY /Cars/Details/{id} CarsController.Details",
      "ANY /Cars/List CarsController.List",
      "ANY /Parts/Details/{id} PartsController.Details",
      "ANY /Parts/Export PartsController.Export",
      "ANY /Parts/List PartsController.List",
      "POST /Cars/Delete/{id} CarsController.Delete",
      "POST /Parts/Delete/{id} PartsController.Delete",
    ]);
  });

  it("reads Web API 2 [RoutePrefix] as the class template", async () => {
    const out = await analyze({
      "Site/Controllers/CarsController.cs": `
using System.Web.Http;
[RoutePrefix("api/cars")]
public class CarsController : ApiController {
  [Route("")] public IHttpActionResult GetAll() { return Ok(); }
  [Route("{id:int}")] [HttpGet] public IHttpActionResult Get(int id) { return Ok(); }
  [Route("~/api/legacy/cars")] public IHttpActionResult PostLegacy() { return Ok(); }
}`,
    });
    expect(rows(out)).toEqual([
      "GET /api/cars CarsController.GetAll",
      "GET /api/cars/{id} CarsController.Get",
      "POST /api/legacy/cars CarsController.PostLegacy",
    ]);
  });

  it("invents nothing without a registered pattern", async () => {
    const out = await analyze({
      "Web/Controllers/HomeController.cs": `public class HomeController : Controller { public IActionResult Index() => View(); }`,
    });
    expect(rows(out)).toEqual([]);
  });
});
