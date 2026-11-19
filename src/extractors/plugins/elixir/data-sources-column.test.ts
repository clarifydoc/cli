import { describe, it, expect } from "vitest";
import { httpCalls } from "./index.js";

describe("Elixir api calls carry a column", () => {
  it("points a Req call at its module, after a non-ASCII prefix too", () => {
    const rows = httpCalls([
      "def load do",
      '  Req.get!("https://clubs.example/api/clubs")',
      '  s = "é🚗"; HTTPoison.post("https://clubs.example/api/players", "")',
      "end",
    ]);
    expect(rows.map((d) => [d.line, d.column])).toEqual([[2, 2], [3, 13]]);
  });
});
