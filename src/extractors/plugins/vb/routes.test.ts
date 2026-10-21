import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { vbSpec } from "./index.js";

const lines = (src: string) => src.split("\n");
const classes = (src: string) => vbSpec.extractClasses!(lines(src), []);
const routes = (src: string) => vbSpec.extractRoutes!(lines(src), classes(src), "Controllers/X.vb", []);
const functions = (src: string) => extractFunctionsWithSpec(lines(src), vbSpec);

const CONTROLLER = `
Imports System.Web.Http

Namespace SampleApi.Controllers
    <Route("api/players")>
    <ApiVersion("2")>
    <ApiVersion("1", Deprecated:=True)>
    <Authorize>
    Public Class PlayersController
        Inherits ApiController

        <HttpGet("")>
        <AllowAnonymous>
        Public Function Index() As IHttpActionResult
            Return Ok()
        End Function

        <HttpGet("{id}")> _
        Public Function [Get](id As Integer) As IHttpActionResult
            Return Ok()
        End Function

        <HttpGet("search")>
        Public Function Search(<FromQuery> q As String, <FromQuery> page As Integer, token As CancellationToken) As IHttpActionResult
            Return Ok()
        End Function

        <HttpPost("")>
        <MapToApiVersion("2")>
        Public Function Post(<FromBody> request As CreatePlayerRequest) As IHttpActionResult
            Return Ok()
        End Function

        <HttpPut("{id}")>
        <Authorize(Roles:="Admin, Editor", Policy:="CanEdit")>
        Public Function Put(id As Integer, request As CreatePlayerRequest, <FromHeader> tenant As String) As IHttpActionResult
            Return Ok()
        End Function

        <HttpDelete("{id}"), Authorize(AuthenticationSchemes:="Bearer")>
        Public Function Delete(id As Integer, force As Boolean) As IHttpActionResult
            Return Ok()
        End Function
    End Class
End Namespace
`;

describe("VB ASP.NET routes", () => {
  it("captures every attribute-routed action, including an escaped [Get] name", () => {
    expect(routes(CONTROLLER).map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /api/players -> Index",
      "GET /api/players/{id} -> Get",
      "GET /api/players/search -> Search",
      "POST /api/players -> Post",
      "PUT /api/players/{id} -> Put",
      "DELETE /api/players/{id} -> Delete",
    ]);
  });

  it("inherits the class <Authorize> and lets an action add to or waive it", () => {
    const r = routes(CONTROLLER);
    const byName = Object.fromEntries(r.map((x) => [x.handler, x]));
    expect(byName["Index"]!.auth).toEqual({ policies: [], roles: [], schemes: [], anonymous: true, inherited: false });
    expect(byName["Index"]!.middleware).toEqual(["Authorize", "AllowAnonymous"]);
    expect(byName["Get"]!.auth).toEqual({ policies: [], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(byName["Put"]!.auth).toEqual({ policies: ["CanEdit"], roles: ["Admin", "Editor"], schemes: [], anonymous: false, inherited: false });
    expect(byName["Put"]!.middleware).toEqual(["Authorize", 'Authorize(Roles:="Admin, Editor", Policy:="CanEdit")']);
    expect(byName["Delete"]!.auth!.schemes).toEqual(["Bearer"]);
  });

  it("reads class versions, deprecation and a MapToApiVersion narrowing", () => {
    const r = routes(CONTROLLER);
    const byName = Object.fromEntries(r.map((x) => [x.handler, x]));
    expect(byName["Get"]!.versions).toEqual(["2", "1"]);
    expect(byName["Get"]!.deprecatedVersions).toEqual(["1"]);
    expect(byName["Post"]!.versions).toEqual(["2"]);
    expect(byName["Post"]!.deprecatedVersions).toBeUndefined();
  });

  it("binds parameters from <FromX> attributes, path tokens and the simple/complex default", () => {
    const r = routes(CONTROLLER);
    const byName = Object.fromEntries(r.map((x) => [x.handler, x]));
    expect(byName["Get"]!.params).toEqual([{ name: "id", type: "Integer", binding: "route", inferred: true }]);
    expect(byName["Search"]!.params).toEqual([
      { name: "q", type: "String", binding: "query" },
      { name: "page", type: "Integer", binding: "query" },
    ]);
    expect(byName["Post"]!.params).toEqual([{ name: "request", type: "CreatePlayerRequest", binding: "body" }]);
    expect(byName["Put"]!.params).toEqual([
      { name: "id", type: "Integer", binding: "route", inferred: true },
      { name: "request", type: "CreatePlayerRequest", binding: "body", inferred: true },
      { name: "tenant", type: "String", binding: "header" },
    ]);
    expect(byName["Delete"]!.params).toEqual([
      { name: "id", type: "Integer", binding: "route", inferred: true },
      { name: "force", type: "Boolean", binding: "query", inferred: true },
    ]);
  });

  it("keeps the convention fallback for an un-attributed controller, with class guards", () => {
    const r = routes(`
<Authorize>
Public Class CarsController
    Inherits ApiController
    Public Function [Get](id As Integer) As IHttpActionResult
        Return Ok()
    End Function
    Public Function Post(car As CreateCar) As IHttpActionResult
        Return Ok()
    End Function
End Class
`);
    expect(r.map((x) => `${x.httpMethod} ${x.path}`)).toEqual(["GET /cars/{id}", "POST /cars"]);
    expect(r[0]!.auth).toEqual({ policies: [], roles: [], schemes: [], anonymous: false, inherited: true });
    expect(r[1]!.params).toEqual([{ name: "car", type: "CreateCar", binding: "body", inferred: true }]);
  });
});

describe("VB parameters", () => {
  it("skips a leading attribute and keeps generic argument lists on the type", () => {
    const [fn] = functions("Public Function Post(<FromBody> items As List(Of Item), Optional page As Integer = 1) As IHttpActionResult\nEnd Function");
    expect(fn.params).toEqual([
      { name: "items", type: "List(Of Item)", defaultValue: null },
      { name: "page", type: "Integer", defaultValue: "1" },
    ]);
  });
});
