import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";

async function callsOf(src: string, lang: "java" | "kotlin") {
  const tree = await parseSource(src, lang as any, lang === "java" ? "Repo.java" : "Repo.kt");
  return new JavaKotlinDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call");
}

describe("Java api calls carry a column", () => {
  it("points a request at its call, after a non-ASCII prefix too", async () => {
    const calls = await callsOf(`import org.keycloak.http.simple.SimpleHttp;
class Repo {
  void m(String url) {
    SimpleHttp.doGet(url, session).asJson();
    String s = "é🚗"; SimpleHttp.doPost(url, session).asJson();
  }
}`, "java");
    expect(calls.map((d) => [d.line, d.column])).toEqual([[4, 4], [5, 22]]);
  });

  it("points a Feign method at its annotation", async () => {
    const calls = await callsOf(`import org.springframework.cloud.openfeign.FeignClient;
@FeignClient(name = "league")
interface LeagueApi {
  @GetMapping("/clubs")
  String clubs();
}`, "java");
    expect(calls.map((d) => [d.line, d.column])).toEqual([[4, 2]]);
  });
});
