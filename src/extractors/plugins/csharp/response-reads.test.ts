import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./data-sources.js";

async function readsOf(src: string): Promise<Array<[string | null, string[] | undefined]>> {
  const tree = await parseSource(src, "csharp" as any, "Client.cs");
  return new CSharpDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => [d.target, d.responseReads]);
}

describe("C# response reads", () => {
  it("reads the typed body's properties as the wire names them", async () => {
    expect(await readsOf(`
public class OrdersClient {
  private readonly HttpClient _http;
  public async Task<decimal> Total(int id) {
    var order = await _http.GetFromJsonAsync<OrderDto>($"/api/orders/{id}");
    Log(order.ToString());
    return order!.Total + (order?.Items.Count ?? 0);
  }
  public async Task<string> Name() {
    var resp = await _http.GetAsync("/api/me");
    var me = await resp.Content.ReadFromJsonAsync<MeDto>();
    return me.DisplayName;
  }
  public Task<OrderDto?> Passed() => _http.GetFromJsonAsync<OrderDto>("/api/x");
}`)).toEqual([["/api/orders/{id}", ["items", "total"]], ["/api/me", ["displayName"]], ["/api/x", undefined]]);
  });
});
