import { describe, it, expect } from "vitest";
import { extractDartDataSources } from "./index.js";

describe("Dart api calls carry a column", () => {
  it("points an http call at its receiver, and a chained verb at its dot", () => {
    const rows = extractDartDataSources([
      "Future<void> load() async {",
      "  final a = await http.get(Uri.parse('https://clubs.example/api/clubs'));",
      "  final s = 'é🚗'; final b = await dio.post('/api/players');",
      "  await dio",
      "      .delete('/api/matches');",
      "}",
    ]).filter((d) => d.kind === "api-call");
    expect(rows.map((d) => [d.line, d.column])).toEqual([[2, 18], [3, 35], [5, 6]]);
  });
});
