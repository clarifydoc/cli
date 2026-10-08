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
      `new Uri(builder.Configuration["Services:Orders"]!)`,
      `_config["Services:Orders"]`,
      `configuration.GetValue<string>("Services:Orders")`,
      `_configuration.GetSection("Services")["Orders"]`,
      `cfg.GetSection("Services").GetValue<string>("Orders")`,
      `sp.GetRequiredService<IConfiguration>()["Services:Orders"]`,
    ]) {
      expect(csharpBaseRefOf(expr), expr).toEqual({ kind: "config", key: "Services:Orders" });
    }
    expect(csharpBaseRefOf(`config.GetConnectionString("Orders")`)).toEqual({ kind: "config", key: "ConnectionStrings:Orders" });
  });

  it("reads environment variables, literals and fallbacks", () => {
    expect(csharpBaseRefOf(`Environment.GetEnvironmentVariable("ORDERS_URL")`)).toEqual({ kind: "env", key: "ORDERS_URL" });
    expect(csharpBaseRefOf(`new Uri("http://orders:8080")`)).toEqual({ kind: "literal", key: "http://orders:8080" });
    expect(csharpBaseRefOf(`new Uri(_config["Services:Orders"] ?? "http://localhost:5101")`)).toEqual({
      kind: "config", key: "Services:Orders", fallback: "http://localhost:5101",
    });
  });

  it("reads nothing into what is not configuration", () => {
    expect(csharpBaseRefOf(`_options.Value.BaseUrl`)).toBeNull();
    expect(csharpBaseRefOf(`_cache["Services:Orders"]`)).toBeNull();
    expect(csharpBaseRefOf(`"api/orders"`)).toBeNull();
  });
});

describe("C# HTTP client registrations", () => {
  it("keys a typed client by its implementation, a named one by its name", async () => {
    expect(await registrationsOf(`
builder.Services.AddHttpClient<InventoryClient>(c => c.BaseAddress = new Uri(builder.Configuration["Services:Inventory"]!));
builder.Services.AddHttpClient<IOrders, Shop.Clients.OrdersClient>(c => { c.Timeout = TimeSpan.FromSeconds(5); c.BaseAddress = new Uri("http://orders:8080"); });
builder.Services.AddHttpClient("legacy", c => c.BaseAddress = new Uri("http://legacy:8080"));
builder.Services.AddHttpClient<BillingClient>().ConfigureHttpClient(c => c.BaseAddress = new Uri(Environment.GetEnvironmentVariable("BILLING_URL")!));
`)).toEqual([
      { client: "InventoryClient", scope: "project", base: { kind: "config", key: "Services:Inventory" } },
      { client: "OrdersClient", scope: "project", base: { kind: "literal", key: "http://orders:8080" } },
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
    expect(await clientOfCall(`class A { HttpClient _http; A(IHttpClientFactory f) { _http = f.CreateClient("orders"); } Task M() => _http.GetFromJsonAsync<X>("api/x"); }`, "GetFromJsonAsync")).toEqual({ kind: "client", key: "name:orders" });
    expect(await clientOfCall(`class A { Task M() => _factory.CreateClient("billing").GetAsync("api/x"); }`, "GetAsync")).toEqual({ kind: "client", key: "name:billing" });
    expect(await clientOfCall(`class InventoryClient { HttpClient _http; Task M() => _http.GetFromJsonAsync<X>("api/items"); }`, "GetFromJsonAsync"))
      .toEqual({ kind: "client", key: "InventoryClient" });
  });
});

describe("C# configuration files", () => {
  const [appsettings, launchSettings] = csharpServiceConfig.sources!;

  it("flattens appsettings to `:` keys, with the profile from the file name", () => {
    const text = `{
  // comments are allowed
  "Services": { "Orders": "http://localhost:5101" },
  "Urls": "http://localhost:5000;https://localhost:5001",
}`;
    expect(appsettings!.parse(text, "appsettings.Development.json")).toEqual([
      { key: "Services:Orders", value: "http://localhost:5101", line: 3, profile: "Development" },
      { key: "Urls", value: "http://localhost:5000", line: 4, profile: "Development", listen: true },
      { key: "Urls", value: "https://localhost:5001", line: 4, profile: "Development", listen: true },
    ]);
    expect(appsettings!.parse(`{"Services":{"Orders":"http://legacy"}}`, "appsettings.Test.json")[0]).toMatchObject({ test: true });
  });

  it("reads launchSettings listen URLs and profile environment", () => {
    const text = JSON.stringify({
      profiles: { Api: { applicationUrl: "https://localhost:7101;http://localhost:5101", environmentVariables: { Services__Inventory: "http://localhost:5102" } } },
    });
    expect(launchSettings!.parse(text, "Properties/launchSettings.json").map(({ line: _l, ...e }) => e)).toEqual([
      { key: "applicationUrl", value: "https://localhost:7101", profile: "Api", listen: true },
      { key: "applicationUrl", value: "http://localhost:5101", profile: "Api", listen: true },
      { key: "Services__Inventory", value: "http://localhost:5102", profile: "Api", env: true },
    ]);
  });

  it("maps a configuration key to the environment variable that overrides it", () => {
    expect(csharpServiceConfig.envNamesFor!("Services:Orders")).toEqual(["Services__Orders"]);
  });
});
