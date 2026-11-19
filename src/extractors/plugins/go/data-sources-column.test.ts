import { describe, it, expect } from "vitest";
import { extractGoDataSources } from "./data-sources.js";

describe("Go api calls carry a column", () => {
  it("points net/http, client and Resty calls at their start, after a non-ASCII prefix too", () => {
    const rows = extractGoDataSources([
      "// resty.New()",
      "func load(client *http.Client) {",
      '\thttp.Get("/api/clubs")',
      '\ts := "é🚗"; client.Post("/api/players")',
      '\tr, _ := rc.R().SetBody(x).Get("/api/matches")',
      "}",
    ]).filter((d) => d.kind === "api-call");
    expect(rows.map((d) => [d.line, d.column])).toEqual([[3, 1], [4, 13], [5, 27]]);
  });
});
