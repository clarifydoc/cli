import { describe, it, expect } from "vitest";
import { extractSwiftDataSources } from "./data-sources.js";

describe("Swift api calls carry a column", () => {
  it("points an Alamofire call and a URLSession call at their start, after a non-ASCII prefix too", () => {
    const rows = extractSwiftDataSources([
      "func load() {",
      '    AF.request("https://clubs.example/api/clubs")',
      '    let s = "é🚗"; client.post("https://clubs.example/api/players")',
      "    let (d, _) = try await URLSession.shared.data(from: URL(string: \"https://clubs.example/api/matches\")!)",
      "}",
    ]).filter((d) => d.kind === "api-call");
    expect(rows.map((d) => [d.line, d.column])).toEqual([[2, 4], [3, 19], [4, 27]]);
  });
});
