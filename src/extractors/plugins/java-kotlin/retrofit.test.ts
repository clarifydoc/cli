import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractRetrofitClients } from "./retrofit.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";

describe("Retrofit", () => {
  it("registers each API interface with the base its builder names, chained or through a variable", () => {
    const kt = `const val BASE_URL = "https://api.shop.test/"
object Net {
  val orders: OrdersApi = Retrofit.Builder().baseUrl(BASE_URL).addConverterFactory(MoshiConverterFactory.create()).build().create(OrdersApi::class.java)
  private val retrofit = Retrofit.Builder()
      .baseUrl("https://auth.shop.test/")
      .build()
  val auth = retrofit.create(AuthApi::class.java)
}`;
    expect(extractRetrofitClients(kt).map((r) => `${r.client} ${r.base?.key ?? "-"} @${r.line}`)).toEqual([
      "OrdersApi https://api.shop.test/ @3",
      "AuthApi https://auth.shop.test/ @7",
    ]);
  });

  it("names the declaring interface as the client of each call it declares", async () => {
    const src = `interface OrdersApi {
    @GET("orders/{id}")
    suspend fun order(@Path("id") id: String): Order
}`;
    const tree = await parseSource(src, "kotlin" as never, "OrdersApi.kt");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(rows.map((r) => [r.name, r.target, r.baseRef])).toEqual([["GET", "/orders/{id}", { kind: "client", key: "OrdersApi" }]]);
  });
});
