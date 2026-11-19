import { describe, it, expect } from "vitest";
import { extractPascalDataSources } from "./data-sources.js";

describe("Pascal api calls carry a column", () => {
  it("points an Indy call at its receiver, and states none after a stripped comment", () => {
    const rows = extractPascalDataSources([
      "begin",
      "  Body := IdHTTP1.Get('http://clubs.example/api/clubs');",
      "  { é🚗 } Body := IdHTTP1.Get('http://clubs.example/api/players');",
    ]).filter((d) => d.kind === "api-call");
    expect(rows.map((d) => [d.line, d.column])).toEqual([[2, 10], [3, undefined]]);
  });
});
