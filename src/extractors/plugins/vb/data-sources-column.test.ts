import { describe, it, expect } from "vitest";
import { extractVbDataSources } from "./data-sources.js";

describe("VB api calls carry a column", () => {
  it("points a COM request and an HttpClient call at their start", () => {
    const rows = extractVbDataSources([
      "Sub Load()",
      '    http.Open "GET", "https://clubs.example/api/clubs", False',
      '    Dim s = "é🚗" : Dim r = Await client.GetAsync("/api/players")',
      "End Sub",
    ], []).filter((d) => d.kind === "api-call");
    expect(rows.map((d) => [d.line, d.column])).toEqual([[2, 8], [3, 34]]);
  });
});
