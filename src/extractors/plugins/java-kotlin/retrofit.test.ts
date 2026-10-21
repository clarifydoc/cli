import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractRetrofitClients } from "./retrofit.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";

describe("Retrofit", () => {
  it("registers each API interface with the base its builder names, chained or through a variable", () => {
    const kt = `const val BASE_URL = "https://api.shop.test/"
object Net {
  val cars: CarsApi = Retrofit.Builder().baseUrl(BASE_URL).addConverterFactory(MoshiConverterFactory.create()).build().create(CarsApi::class.java)
  private val retrofit = Retrofit.Builder()
      .baseUrl("https://auth.shop.test/")
      .build()
  val auth = retrofit.create(AuthApi::class.java)
}`;
    expect(extractRetrofitClients(kt).map((r) => `${r.client} ${r.base?.key ?? "-"} @${r.line}`)).toEqual([
      "CarsApi https://api.shop.test/ @3",
      "AuthApi https://auth.shop.test/ @7",
    ]);
  });

  it("names the declaring interface as the client of each call it declares", async () => {
    const src = `interface CarsApi {
    @GET("cars/{id}")
    suspend fun car(@Path("id") id: String): Car
}`;
    const tree = await parseSource(src, "kotlin" as never, "CarsApi.kt");
    const rows = new JavaKotlinDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
    expect(rows.map((r) => [r.name, r.target, r.baseRef])).toEqual([["GET", "/cars/{id}", { kind: "client", key: "CarsApi" }]]);
  });
});
