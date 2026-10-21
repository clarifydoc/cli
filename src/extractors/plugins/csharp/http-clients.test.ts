import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import type { Node } from "web-tree-sitter";
import { parseSource } from "../../../parsers/parser-manager.js";
import { csharpCallClient, extractCsharpHttpClientRegistrations } from "./http-clients.js";
import { csharpBaseRefOf, csharpServiceConfig } from "./service-config.js";

async function registrationsOf(src: string) {
  const tree = await parseSource(src, "csharp" as any, "Program.cs");
  return extractCsharpHttpClientRegistrations(tree, src).map(({ line: _line, ...r }) => r);
}

describe("csharpBaseRefOf", () => {
  it("reads configuration keys however they are spelled", () => {
    for (const expr of [
      `new Uri(builder.Configuration["Services:Cars"]!)`,
      `_config["Services:Cars"]`,
      `configuration.GetValue<string>("Services:Cars")`,
      `_configuration.GetSection("Services")["Cars"]`,
      `cfg.GetSection("Services").GetValue<string>("Cars")`,
      `sp.GetRequiredService<IConfiguration>()["Services:Cars"]`,
    ]) {
      expect(csharpBaseRefOf(expr), expr).toEqual({ kind: "config", key: "Services:Cars" });
    }
    expect(csharpBaseRefOf(`config.GetConnectionString("Cars")`)).toEqual({ kind: "config", key: "ConnectionStrings:Cars" });
  });

  it("reads environment variables, literals and fallbacks", () => {
    expect(csharpBaseRefOf(`Environment.GetEnvironmentVariable("CARS_URL")`)).toEqual({ kind: "env", key: "CARS_URL" });
    expect(csharpBaseRefOf(`new Uri("http://cars:8080")`)).toEqual({ kind: "literal", key: "http://cars:8080" });
    expect(csharpBaseRefOf(`new Uri(_config["Services:Cars"] ?? "http://localhost:5101")`)).toEqual({
      kind: "config", key: "Services:Cars", fallback: "http://localhost:5101",
    });
  });

  it("reads nothing into what is not configuration", () => {
    expect(csharpBaseRefOf(`_options.Value.BaseUrl`)).toBeNull();
    expect(csharpBaseRefOf(`_cache["Services:Cars"]`)).toBeNull();
    expect(csharpBaseRefOf(`"api/cars"`)).toBeNull();
  });
});

describe("C# HTTP client registrations", () => {
  it("keys a typed client by its implementation, a named one by its name", async () => {
    expect(await registrationsOf(`
builder.Services.AddHttpClient<FleetClient>(c => c.BaseAddress = new Uri(builder.Configuration["Services:Fleet"]!));
builder.Services.AddHttpClient<ICars, Shop.Clients.CarsClient>(c => { c.Timeout = TimeSpan.FromSeconds(5); c.BaseAddress = new Uri("http://cars:8080"); });
builder.Services.AddHttpClient("legacy", c => c.BaseAddress = new Uri("http://legacy:8080"));
builder.Services.AddHttpClient<BillingClient>().ConfigureHttpClient(c => c.BaseAddress = new Uri(Environment.GetEnvironmentVariable("BILLING_URL")!));
`)).toEqual([
      { client: "FleetClient", scope: "project", base: { kind: "config", key: "Services:Fleet" } },
      { client: "CarsClient", scope: "project", base: { kind: "literal", key: "http://cars:8080" } },
      { client: "name:legacy", scope: "project", base: { kind: "literal", key: "http://legacy:8080" } },
      { client: "BillingClient", scope: "project", base: { kind: "env", key: "BILLING_URL" } },
    ]);
  });

  it("registers a class that sets its own client's base", async () => {
    expect(await registrationsOf(`
class Payments { private readonly HttpClient _http = new HttpClient { BaseAddress = new Uri("https://api.stripe.com") }; }
class Catalog { public Catalog(HttpClient http, IConfiguration config) { http.BaseAddress = new Uri(config["Services:Catalog"]); } }
`)).toEqual([
      { client: "Payments", scope: "project", base: { kind: "literal", key: "https://api.stripe.com" } },
      { client: "Catalog", scope: "project", base: { kind: "config", key: "Services:Catalog" } },
    ]);
  });
});

describe("csharpCallClient", () => {
  async function clientOfCall(src: string, method: string) {
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    const find = (n: Node): Node | null => {
      if (n.type === "invocation_expression" && n.childForFieldName("function")?.text.replace(/<[^<>]*>$/, "").endsWith(method)) return n;
      for (const c of n.namedChildren) {
        const hit = c && find(c);
        if (hit) return hit;
      }
      return null;
    };
    const call = find(tree.rootNode)!;
    const root = call.childForFieldName("function")!.text.split(".")[0]!;
    return csharpCallClient(call, root);
  }

  it("names the client a CreateClient local or field came from, else the enclosing class", async () => {
    expect(await clientOfCall(`class A { async Task M() { var client = _factory.CreateClient("legacy"); await client.GetAsync("api/items"); } }`, "GetAsync"))
      .toEqual({ kind: "client", key: "name:legacy" });
    expect(await clientOfCall(`class A { HttpClient _http; A(IHttpClientFactory f) { _http = f.CreateClient("cars"); } Task M() => _http.GetFromJsonAsync<X>("api/x"); }`, "GetFromJsonAsync")).toEqual({ kind: "client", key: "name:cars" });
    expect(await clientOfCall(`class A { Task M() => _factory.CreateClient("billing").GetAsync("api/x"); }`, "GetAsync")).toEqual({ kind: "client", key: "name:billing" });
    expect(await clientOfCall(`class FleetClient { HttpClient _http; Task M() => _http.GetFromJsonAsync<X>("api/items"); }`, "GetFromJsonAsync"))
      .toEqual({ kind: "client", key: "FleetClient" });
  });
});

describe("C# configuration files", () => {
  const [appsettings, launchSettings] = csharpServiceConfig.sources!;

  it("flattens appsettings to `:` keys, with the profile from the file name", () => {
    const text = `{
  // comments are allowed
  "Services": { "Cars": "http://localhost:5101" },
  "Urls": "http://localhost:5000;https://localhost:5001",
}`;
    expect(appsettings!.parse(text, "appsettings.Development.json")).toEqual([
      { key: "Services:Cars", value: "http://localhost:5101", line: 3, profile: "Development" },
      { key: "Urls", value: "http://localhost:5000", line: 4, profile: "Development", listen: true },
      { key: "Urls", value: "https://localhost:5001", line: 4, profile: "Development", listen: true },
    ]);
    expect(appsettings!.parse(`{"Services":{"Cars":"http://legacy"}}`, "appsettings.Test.json")[0]).toMatchObject({ test: true });
  });

  it("reads launchSettings listen URLs and profile environment", () => {
    const text = JSON.stringify({
      profiles: { Api: { applicationUrl: "https://localhost:7101;http://localhost:5101", environmentVariables: { Services__Fleet: "http://localhost:5102" } } },
    });
    expect(launchSettings!.parse(text, "Properties/launchSettings.json").map(({ line: _l, ...e }) => e)).toEqual([
      { key: "applicationUrl", value: "https://localhost:7101", profile: "Api", listen: true },
      { key: "applicationUrl", value: "http://localhost:5101", profile: "Api", listen: true },
      { key: "Services__Fleet", value: "http://localhost:5102", profile: "Api", env: true },
    ]);
  });

  it("maps a configuration key to the environment variable that overrides it", () => {
    expect(csharpServiceConfig.envNamesFor!("Services:Cars")).toEqual(["Services__Cars"]);
  });
});

describe("C# gateway routes", () => {
  const [yarp, ocelot] = csharpServiceConfig.proxySources!;
  const strip = (rules: Array<{ line?: number }>) => rules.map(({ line: _l, ...r }) => r);

  it("reads YARP routes through their cluster destinations and path transforms", () => {
    const text = JSON.stringify({
      ReverseProxy: {
        Routes: {
          cars: { ClusterId: "cars", Match: { Path: "/api/cars/{**catch-all}" } },
          legacy: { ClusterId: "cars", Match: { Path: "/legacy/{**rest}" }, Transforms: [{ PathRemovePrefix: "/legacy" }] },
          stock: { ClusterId: "inv", Match: { Path: "/stock/{**rest}" }, Transforms: [{ PathPattern: "/api/items/{**rest}" }] },
        },
        Clusters: {
          cars: { Destinations: { a: { Address: "http://cars:8080/" } } },
          inv: { Destinations: { a: { Address: "http://fleet:8080" }, b: { Address: "http://fleet-2:8080" } } },
        },
      },
    });
    expect(strip(yarp!.parse(text, "appsettings.json"))).toEqual([
      { pathPrefix: "/api/cars", target: "http://cars:8080/", via: "yarp" },
      { pathPrefix: "/legacy", target: "http://cars:8080/", rewriteTo: "", via: "yarp" },
      { pathPrefix: "/stock", target: "http://fleet:8080", rewriteTo: "/api/items", via: "yarp" },
      { pathPrefix: "/stock", target: "http://fleet-2:8080", rewriteTo: "/api/items", via: "yarp" },
    ]);
    expect(yarp!.parse(text, "appsettings.Test.json")).toEqual([]);
  });

  it("reads Ocelot routes, upstream template to downstream host and template", () => {
    const text = JSON.stringify({ Routes: [{
      UpstreamPathTemplate: "/cars/{everything}", DownstreamPathTemplate: "/api/cars/{everything}",
      DownstreamScheme: "http", DownstreamHostAndPorts: [{ Host: "cars", Port: 8080 }],
    }] });
    expect(strip(ocelot!.parse(text, "ocelot.json"))).toEqual([
      { pathPrefix: "/cars", target: "http://cars:8080", rewriteTo: "/api/cars", via: "ocelot" },
    ]);
  });
});
