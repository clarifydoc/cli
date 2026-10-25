import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { csharpRouteExtractor } from "../csharp/routes/aspnet.js";
import { javascriptRouteExtractor } from "../javascript/routes/index.js";
import { extractPythonRoutes } from "../python/routes.js";
import { azureHostJson, azureRouteBase } from "./azure-functions.js";
import type { RouteInfo } from "../../../types/analysis.js";

const rows = (routes: RouteInfo[]) => routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`);

describe("Azure Functions HTTP triggers", () => {
  it("C#: isolated and in-process functions, Route or the function name, the verbs or any", async () => {
    const src = `
public class KitFunctions
{
    [Function("GetKit")]
    public Task<HttpResponseData> GetKit([HttpTrigger(AuthorizationLevel.Function, "get", Route = "kits/{id}")] HttpRequestData req, string id) => null;

    [Function("ListCars")]
    public HttpResponseData ListCars([HttpTrigger(AuthorizationLevel.Anonymous, "get", "post")] HttpRequestData req) => null;

    [FunctionName("WashCar")]
    public static IActionResult Run([HttpTrigger(AuthorizationLevel.Admin, Route = "cars/{id:int}/wash")] HttpRequest req) => null;

    [Function("Nightly")]
    public void Nightly([TimerTrigger("0 0 * * *")] TimerInfo timer) { }
}`;
    const tree = await parseSource(src, "csharp" as never, "KitFunctions.cs");
    const routes = csharpRouteExtractor.extractRoutes(tree, src, "KitFunctions.cs", []);
    expect(rows(routes)).toEqual(["GET /kits/{id} GetKit", "GET /ListCars ListCars", "POST /ListCars ListCars", "ALL /cars/{id:int}/wash Run"]);
    expect(routes[1]!.auth?.anonymous).toBe(true);
    expect(routes[3]!.auth?.schemes).toEqual(["function-key:admin"]);
  });

  it("JS/TS v4 model: app.http(name, { methods, route, handler })", async () => {
    const src = `
const { app } = require('@azure/functions');
app.http('getCar', { methods: ['GET'], authLevel: 'anonymous', route: 'cars/{id}', handler: async (request, context) => ({ jsonBody: {} }) });
app.http('listCars', { handler: listCars });
`;
    const tree = await parseSource(src, "javascript", "cars.js");
    const routes = javascriptRouteExtractor.extractRoutes(tree, src, "cars.js");
    expect(rows(routes)).toEqual(["GET /cars/{id} null", "ALL /listCars listCars"]);
  });

  it("Python v2 model: @app.route(route=…), the function_name or def name otherwise, any method unless listed", async () => {
    const src = `
import azure.functions as func
app = func.FunctionApp()

@app.route(route="drivers/{id}", methods=["GET"])
def get_driver(req):
    return func.HttpResponse("{}")

@app.function_name(name="ListDrivers")
@app.route(methods=["GET", "POST"], auth_level=func.AuthLevel.ANONYMOUS)
def list_drivers(req):
    return func.HttpResponse("[]")

@app.route()
def ping(req):
    return func.HttpResponse("ok")
`;
    const tree = await parseSource(src, "python" as never, "function_app.py");
    const routes: RouteInfo[] = [];
    extractPythonRoutes(tree.rootNode, routes);
    expect(rows(routes)).toEqual(["GET /drivers/{id} get_driver", "GET /ListDrivers list_drivers", "POST /ListDrivers list_drivers", "ALL /ping ping"]);
    expect(routes[1]!.auth?.anonymous).toBe(true);
  });

  it("serves the routes under host.json's routePrefix: api by default, none for an empty one", () => {
    const base = (text: string) => azureRouteBase(azureHostJson.parse(text, "host.json").map((e) => ({ ...e, file: "fn/host.json" })));
    expect(base(`{ "version": "2.0" }`)).toMatchObject({ path: "/api" });
    expect(base(`{ "version": "2.0", "extensions": { "http": { "routePrefix": "garage/v1" } } }`)).toMatchObject({ path: "/garage/v1", key: "extensions.http.routePrefix" });
    expect(base(`{ "version": "2.0", "extensions": { "http": { "routePrefix": "" } } }`)).toBeNull();
    // A host.json that is not a Functions host file.
    expect(base(`{ "port": 8080 }`)).toBeNull();
  });
});
