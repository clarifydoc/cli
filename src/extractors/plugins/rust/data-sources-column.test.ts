import { describe, it, expect } from "vitest";
import { extractRustDataSources } from "./data-sources.js";

describe("Rust api calls carry a column", () => {
  it("points reqwest calls, a chained verb and a wrapper's request at their start", () => {
    const rows = extractRustDataSources([
      "async fn load(client: &Client, http_client: &Client) {",
      '    client.get("/api/clubs").send().await;',
      '    let s = "é🚗"; client.post("/api/players").send().await;',
      "    client",
      '        .delete("/api/matches")',
      "        .send().await;",
      '    http_client.request(Method::GET, "/api/cars");',
      "}",
    ]).filter((d) => d.kind === "api-call");
    expect([...rows].sort((a, b) => a.line - b.line).map((d) => [d.name, d.line, d.column])).toEqual([["GET", 2, 4], ["POST", 3, 19], ["DELETE", 5, 8], ["GET", 7, 15]]);
  });
});
